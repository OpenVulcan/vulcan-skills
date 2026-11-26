import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import semver from 'semver'
import { parse as parseYaml } from 'yaml'
import { parse as parseToml } from 'smol-toml'
import { childEnvironment, runCommand } from './process.js'
import { atomicJson, parseJson, registryUrl, SkillError, withLock } from './support.js'
import { Toolchain, TOOLCHAIN } from './toolchain.js'

// Match a dependency URL against the host-approved source boundary.
// 按宿主批准的来源边界校验依赖地址。
function sourceAllowed(value, registry) {
  const url = new URL(value)
  return url.origin === registry.origin && url.pathname.startsWith(registry.pathname) && !url.username && !url.password
}

// Check Node project declarations before the pinned package manager reads them.
// 在固定版本的包管理器读取 Node 项目前检查依赖声明。
function validateNode(packageJson, lock, registry) {
  const manifest = parseJson(packageJson, 'node/package.json')
  if (manifest.engines?.node && !semver.satisfies(TOOLCHAIN.node, manifest.engines.node)) {
    throw new SkillError('incompatible_runtime', `Node ${TOOLCHAIN.node} does not satisfy ${manifest.engines.node}.`)
  }
  if (manifest.workspaces || manifest.pnpm || manifest.devEngines || manifest.overrides) {
    throw new SkillError('invalid_dependencies', 'Use a standalone package with registry dependencies.')
  }
  for (const field of ['dependencies', 'optionalDependencies', 'devDependencies', 'peerDependencies']) {
    for (const spec of Object.values(manifest[field] ?? {})) {
      if (typeof spec !== 'string' || !(semver.validRange(spec) || /^[a-z][a-z0-9._-]*$/i.test(spec))) {
        throw new SkillError('invalid_dependencies', `Unsupported npm dependency specifier: ${spec}`)
      }
    }
  }
  const parsed = parseYaml(lock, { maxAliasCount: 0 })
  if (!parsed || typeof parsed !== 'object' || !parsed.importers ||
    Object.keys(parsed.importers).length !== 1 || !Object.hasOwn(parsed.importers, '.') || parsed.patchedDependencies) {
    throw new SkillError('invalid_dependencies', 'The lockfile must describe one registry-backed project.')
  }
  for (const [name, item] of Object.entries(parsed.packages ?? {})) {
    if (!/^(?:@[\w.-]+\/)?[\w.-]+@\d+\.\d+\.\d+(?:[-+][\w.-]+)*$/.test(name) ||
      item.resolution?.type || !/^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(item.resolution?.integrity) ||
      (item.resolution.tarball && !sourceAllowed(item.resolution.tarball, registry))) {
      throw new SkillError('invalid_dependencies', `Unsupported locked npm artifact: ${name}`)
    }
  }
  // Package managers can follow non-registry references from importer and snapshot values.
  // 包管理器可能从导入项目和快照值跟随非 Registry 引用。
  const queue = [parsed.importers, parsed.snapshots ?? {}]
  while (queue.length) {
    const value = queue.pop()
    if (typeof value === 'string' && /^(?:file:|link:|workspace:|git(?:\+|:|@)|https?:|patch:|portal:|github:|gitlab:|bitbucket:|\.\.?[/\\])/i.test(value)) {
      throw new SkillError('invalid_dependencies', `Unsupported npm lockfile reference: ${value}`)
    }
    if (value && typeof value === 'object') queue.push(...Object.values(value))
  }
}

// Require pinned wheels from the supported Python index before invoking uv.
// 调用 uv 前，要求依赖为受支持 Python 索引中的锁定 Wheel。
function validatePython(project, lock) {
  const manifest = parseToml(project)
  if (manifest.tool?.uv || manifest['dependency-groups']) throw new SkillError('invalid_dependencies', 'Publish a standalone Python project with production dependencies.')
  const dependencies = [...(manifest.project?.dependencies ?? []), ...Object.values(manifest.project?.['optional-dependencies'] ?? {}).flat()]
  if (dependencies.some(spec => typeof spec !== 'string' || /^[\w.-]+(?:\[[^\]]*\])?\s*@/u.test(spec.trim()))) {
    throw new SkillError('invalid_dependencies', 'Python dependencies must use index-backed package requirements.')
  }
  const parsed = parseToml(lock)
  for (const item of parsed.package ?? []) {
    const source = item.source
    if (source?.virtual === '.' || source?.editable === '.') {
      if (item.name === manifest.project?.name?.toLowerCase().replace(/[-_.]+/g, '-')) continue
    }
    if (source?.registry !== 'https://pypi.org/simple' && source?.registry !== 'https://pypi.org/simple/') {
      throw new SkillError('invalid_dependencies', `Unsupported Python source: ${item.name}`)
    }
    if (!item.wheels?.length || item.wheels.some(wheel =>
      new URL(wheel.url).origin !== 'https://files.pythonhosted.org' || !/^sha256:[0-9a-f]{64}$/.test(wheel.hash))) {
      throw new SkillError('invalid_dependencies', `Python dependency lacks registry-provided wheels: ${item.name}`)
    }
  }
}

// Prepare and cache exact package imports using the distribution's shared toolchain.
// 使用发行版共享的工具链准备并缓存技能包导入环境。
export class Environments {
  constructor(home, toolchain = new Toolchain(home)) {
    this.home = home
    this.toolchain = toolchain
  }

  // Build one language environment and return its executable and package code root.
  // 准备一种语言的环境并返回解释器和包代码目录。
  async resolve(pkg, language, registryValue, signal) {
    const declaration = pkg.manifest.runtimes[language]
    const interpreter = await this.toolchain[language](signal)
    if (declaration.dependencies === 'none') return { interpreter, root: pkg.root }
    const registry = registryUrl(registryValue)
    const identity = createHash('sha256').update(JSON.stringify([pkg.record.digest, language, TOOLCHAIN, registry.href, process.platform, process.arch])).digest('hex')
    const directory = path.join(this.home, 'environments', identity)
    const lock = path.join(this.home, 'environment-locks', identity)
    const ready = path.join(directory, 'ready.json')
    const runner = language === 'python' ? path.join(directory, 'python', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python') : interpreter
    const published = async () => {
      try { return parseJson(await readFile(ready, 'utf8'), ready).identity === identity } catch (error) {
        if (error.code === 'ENOENT') return false
        throw error
      }
    }
    if (!await published()) await withLock(lock, async () => {
      if (await published()) return
      signal.throwIfAborted()
      // Preserve the environment's final path while tools create interpreter launchers.
      // 安装工具创建解释器启动器时，保留环境最终使用的目录路径。
      await rm(directory, { recursive: true, force: true })
      await mkdir(directory, { recursive: true })
      const projectRoot = path.join(directory, language)
      const canonical = path.join(pkg.root, language)
      const config = language === 'node' ? 'package.json' : 'pyproject.toml'
      const lockfile = language === 'node' ? 'pnpm-lock.yaml' : 'uv.lock'
      const project = await readFile(path.join(canonical, config), 'utf8')
      const frozen = await readFile(path.join(canonical, lockfile), 'utf8')
      await mkdir(projectRoot)
      await writeFile(path.join(projectRoot, config), project)
      await writeFile(path.join(projectRoot, lockfile), frozen)
      if (language === 'node') {
        validateNode(project, frozen, registry)
        const pnpm = await this.toolchain.pnpm(signal)
        const userConfig = path.join(directory, 'registry.npmrc')
        await writeFile(userConfig, `registry=${registry.href}\nignore-scripts=true\nmanage-package-manager-versions=false\n`)
        const env = childEnvironment({
          HOME: directory, USERPROFILE: directory, NPM_CONFIG_USERCONFIG: userConfig,
          NPM_CONFIG_GLOBALCONFIG: path.join(directory, 'empty.npmrc'),
          COREPACK_ENABLE_PROJECT_SPEC: '0',
        })
        await runCommand([interpreter, pnpm, 'install', '--prod', '--frozen-lockfile', '--ignore-scripts',
          '--config.manage-package-manager-versions=false', `--registry=${registry.href}`, '--store-dir', path.join(this.home, 'pnpm-store')],
        { cwd: projectRoot, env, signal })
      } else {
        validatePython(project, frozen)
        const uv = await this.toolchain.uv(signal)
        const env = childEnvironment({ HOME: directory, USERPROFILE: directory, UV_CACHE_DIR: path.join(this.home, 'uv-cache'), UV_NO_PROGRESS: '1' })
        await runCommand([uv, '--no-config', 'sync', '--locked', '--no-default-groups', '--no-install-project', '--no-build',
          '--no-python-downloads', '--python', interpreter], { cwd: projectRoot, env, signal })
      }
      await cp(canonical, projectRoot, { recursive: true, force: false, filter(source) {
        const relative = path.relative(canonical, source)
        return relative !== config && relative !== lockfile
      } })
      await atomicJson(ready, { identity })
    }, signal)
    return { interpreter: runner, root: directory }
  }
}
