import { createHash } from 'node:crypto'
import { access, chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { unzipSync } from 'fflate'
import { extractTar, registryArchive } from './archive.js'
import { childEnvironment, runCommand } from './process.js'
import { download, parseJson, SkillError, withLock } from './support.js'

// Keep one shared and reproducible toolchain per 0.1.x distribution.
// 为 0.1.x 发行系列提供一套共享且可重现的工具链。
export const TOOLCHAIN = Object.freeze({ node: '24.18.0', python: '3.14.6', pnpm: '11.11.0', uv: '0.12.10' })
const NODE_ORIGIN = 'https://nodejs.org'
const NPM_ORIGIN = new URL('https://registry.npmjs.org/')
const MAX_TOOLCHAIN = 160 * 1024 * 1024
const WINDOWS = process.platform === 'win32'

// Return a path only when the published tool exists.
// 仅在已发布工具实际存在时返回对应路径。
async function exists(file) {
  try { await access(file); return true } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

// Compose the asset name from the platform names used by the official Node distribution.
// 以 Node 官方发行包的平台命名组合产物文件名。
function nodeAsset() {
  const platform = { win32: 'win', darwin: 'darwin', linux: 'linux' }[process.platform]
  if (!platform || !['x64', 'arm64'].includes(process.arch)) throw new SkillError('unsupported_platform', 'No managed Node build for this platform.')
  const name = `node-v${TOOLCHAIN.node}-${platform}-${process.arch}`
  return { name, archive: `${name}.${WINDOWS ? 'zip' : 'tar.gz'}` }
}

// Resolve the pinned uv wheel for the current platform.
// 解析当前平台所对应的固定版本 uv Wheel。
function uvWheel(files) {
  const platform = process.platform
  const arch = process.arch
  const suffix = platform === 'win32'
    ? { x64: 'win_amd64', arm64: 'win_arm64' }[arch]
    : platform === 'darwin' ? arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'arm64' : undefined
    : platform === 'linux' ? { x64: 'x86_64', arm64: 'aarch64' }[arch] : undefined
  const found = suffix && files.find(item => {
    const name = item.filename
    if (item.packagetype !== 'bdist_wheel' || typeof name !== 'string') return false
    if (platform === 'win32') return name.endsWith(`-${suffix}.whl`)
    if (platform === 'darwin') return name.includes('macosx_') && name.endsWith(`_${suffix}.whl`)
    return name.includes('manylinux') && name.endsWith(`_${suffix}.whl`)
  })
  if (!found) throw new SkillError('unsupported_platform', 'No managed uv wheel for this platform.')
  return found
}

// Provision versioned toolchain artifacts independently of skill dependency sources.
// 独立于技能依赖源准备固定版本的工具链产物。
export class Toolchain {
  constructor(home) {
    this.root = path.join(home, 'toolchain')
  }

  // Install one verified tool in a temporary slot and publish only a complete generation.
  // 在临时槽中安装并校验工具，只发布完整代次。
  async prepare(name, entry, install, signal) {
    const directory = path.join(this.root, name)
    const executable = path.join(directory, entry)
    if (await exists(executable)) return executable
    return withLock(path.join(this.root, 'locks', name), async () => {
      signal.throwIfAborted()
      if (await exists(executable)) return executable
      const temporary = path.join(this.root, `.${name}.tmp`)
      await rm(temporary, { recursive: true, force: true })
      await mkdir(temporary)
      try {
        await install(temporary)
        if (!(await exists(path.join(temporary, entry)))) throw new SkillError('toolchain_missing', `Missing artifact entry for ${name}.`)
        await rename(temporary, directory)
      } finally {
        await rm(temporary, { recursive: true, force: true })
      }
      return executable
    }, signal)
  }

  // Fetch the official Node archive and verify it against the versioned checksum list.
  // 获取 Node 官方归档并使用对应版本的校验清单验证。
  async node(signal) {
    const { name, archive } = nodeAsset()
    return this.prepare(name, WINDOWS ? 'node.exe' : 'bin/node', async directory => {
      const base = `${NODE_ORIGIN}/dist/v${TOOLCHAIN.node}/`
      const sums = (await download(new URL('SHASUMS256.txt', base), 64 * 1024, signal)).toString('utf8')
      const matches = sums.split(/\r?\n/).map(line => /^([0-9a-f]{64})\s+\*?([^\s]+)$/.exec(line))
      const expected = matches.find(item => item?.[2] === archive)?.[1]
      const data = await download(new URL(archive, base), MAX_TOOLCHAIN, signal)
      if (!expected || createHash('sha256').update(data).digest('hex') !== expected) throw new SkillError('integrity_mismatch', 'Node distribution checksum mismatch.')
      if (WINDOWS) {
        const relative = `${name}/node.exe`
        const files = unzipSync(data, { filter: item => item.name === relative && item.originalSize <= MAX_TOOLCHAIN })
        if (!files[relative]) throw new SkillError('toolchain_missing', 'Node distribution has no interpreter.')
        await writeFile(path.join(directory, 'node.exe'), files[relative], { flag: 'wx' })
      } else {
        // Official POSIX Node tarballs link npm and npx; only the interpreter is used.
        // 官方 POSIX 归档含 npm 与 npx 链接，执行器只使用解释器。
        const { x } = await import('tar')
        const file = path.join(directory, 'node.tar.gz')
        await writeFile(file, data)
        await x({ file, cwd: directory, strip: 1, strict: true, filter: (filename, entry) => filename === `${name}/bin/node` && entry.type === 'File' })
        await rm(file)
        await chmod(path.join(directory, 'bin', 'node'), 0o755)
      }
    }, signal)
  }

  // Use the pinned pnpm module with the same Node executable as the skill.
  // 用与技能相同的 Node 执行固定版本的 pnpm 模块。
  async pnpm(signal) {
    return this.prepare(`pnpm-${TOOLCHAIN.pnpm}`, 'bin/pnpm.mjs', async directory => {
      await extractTar(await registryArchive('pnpm', TOOLCHAIN.pnpm, NPM_ORIGIN, signal), directory, 'package')
    }, signal)
  }

  // Obtain the executable from a hash-verified, platform-specific uv wheel.
  // 从摘要已校验的平台专用 uv Wheel 提取可执行文件。
  async uv(signal) {
    const binary = WINDOWS ? 'uv.exe' : 'uv'
    return this.prepare(`uv-${TOOLCHAIN.uv}`, binary, async directory => {
      const url = new URL(`https://pypi.org/pypi/uv/${TOOLCHAIN.uv}/json`)
      const metadata = parseJson((await download(url, 4 * 1024 * 1024, signal)).toString('utf8'), url.pathname)
      const wheel = uvWheel(metadata.urls)
      const wheelUrl = new URL(wheel.url)
      if (wheelUrl.origin !== 'https://files.pythonhosted.org') throw new SkillError('invalid_source', 'Unexpected uv wheel source.')
      const bytes = await download(wheelUrl, MAX_TOOLCHAIN, signal)
      if (createHash('sha256').update(bytes).digest('hex') !== wheel.digests.sha256) throw new SkillError('integrity_mismatch', 'uv wheel checksum mismatch.')
      const extracted = unzipSync(bytes, { filter: item => item.name.endsWith(`.data/scripts/${binary}`) && item.originalSize <= MAX_TOOLCHAIN })
      const values = Object.values(extracted)
      if (values.length !== 1) throw new SkillError('toolchain_missing', 'uv wheel has no unique executable.')
      await writeFile(path.join(directory, binary), values[0], { mode: 0o755 })
    }, signal)
  }

  // Provision one CPython build through uv's managed Python catalog.
  // 通过 uv 托管目录准备一套 CPython。
  async python(signal) {
    const uv = await this.uv(signal)
    const directory = path.join(this.root, 'python')
    await mkdir(directory, { recursive: true })
    const environment = childEnvironment({
      HOME: this.root, USERPROFILE: this.root, UV_CACHE_DIR: path.join(this.root, 'uv-cache'),
      UV_PYTHON_INSTALL_DIR: directory, UV_NO_PROGRESS: '1',
    }, signal)
    return withLock(directory, async () => {
      const options = { cwd: directory, env: environment, signal }
      const request = `cpython@${TOOLCHAIN.python}`
      await runCommand([uv, '--no-config', 'python', 'install', '--no-bin', request], options)
      const executable = await runCommand([uv, '--no-config', 'python', 'find', '--managed-python', request], options)
      if (!path.isAbsolute(executable) || !await exists(executable)) throw new SkillError('toolchain_missing', 'uv did not return a managed Python executable.')
      return executable
    })
  }
}
