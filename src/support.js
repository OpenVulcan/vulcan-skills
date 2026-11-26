import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rename, rm, writeFile, lstat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import lockfile from 'proper-lockfile'
import { parseDocument } from 'yaml'

export const MAX_PACKAGE_BYTES = 192 * 1024 * 1024
export const MAX_PACKAGE_ENTRIES = 20_000

// Supply structured errors shared by the CLI and the host adapter.
// 为命令行和宿主适配器提供统一的结构化错误。
export class SkillError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.code = code
  }
}

// Load JSON with duplicate-key detection before interpreting any field.
// 读取 JSON 并在解释字段前检测重复键。
export function parseJson(source, label) {
  try {
    const value = JSON.parse(source)
    const document = parseDocument(source, { schema: 'failsafe', uniqueKeys: true })
    if (document.errors.length) throw document.errors[0]
    return value
  } catch (error) {
    throw new SkillError('invalid_json', `Invalid JSON in ${label}: ${error.message}`, { cause: error })
  }
}

// Resolve the same default home for the CLI and the DSH plugin.
// 为命令行与 DSH 插件解析同一个默认数据目录。
export function defaultHome() {
  return path.resolve(process.env.VULCANSKILLS_HOME || path.join(process.env.DSH_HOME || path.join(homedir(), '.dsh'), 'vulcan-skills'))
}

// Normalize a host-owned registry and allow plain HTTP only for local test mirrors.
// 规范化宿主管理的 Registry，仅允许本机镜像使用明文 HTTP。
export function registryUrl(value) {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new SkillError('invalid_source', 'Use an HTTPS registry without credentials in its URL.')
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}

// Avoid implicit redirects and bound every metadata and artifact response.
// 禁止隐式重定向，并限制元数据和下载产物的响应大小。
export async function download(url, limit, signal = AbortSignal.timeout(180_000)) {
  const response = await fetch(url, { redirect: 'error', signal })
  if (!response.ok || response.body === null) throw new SkillError('download_failed', `HTTP ${response.status} from ${url.origin}`)
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body.cancel()
    throw new SkillError('size_limit', 'Download exceeds the permitted size.')
  }
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > limit) throw new SkillError('size_limit', 'Download exceeds the permitted size.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
}

// Serialize cross-process publication inside one existing directory.
// 在同一个目录上串行化跨进程发布操作。
export async function withLock(directory, work, signal = AbortSignal.timeout(60_000)) {
  await mkdir(directory, { recursive: true })
  let release
  while (release === undefined) {
    signal.throwIfAborted()
    try {
      release = await lockfile.lock(directory, { stale: 60_000 })
    } catch (error) {
      if (error.code !== 'ELOCKED') throw error
      await delay(250, undefined, { signal })
    }
  }
  try {
    signal.throwIfAborted()
    return await work()
  } finally {
    await release()
  }
}

// Replace a state file on the same volume to make readers see whole revisions.
// 在同一卷上替换状态文件，确保读取方看到完整的版本。
export async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

// Reject nonportable archive names and paths escaping the package.
// 拒绝不可移植的归档路径和越出包根目录的路径。
export function portablePath(value) {
  if (!value || value.includes('\\') || /^[a-z]:/i.test(value) || value.includes(':') ||
    value.split('/').some(segment => !segment || segment === '.' || segment === '..' ||
      /[<>"|?*\u0000-\u001f]|[ .]$|^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) {
    throw new SkillError('invalid_path', `Invalid package path: ${value}`)
  }
  return value
}

// Open a regular package file whose physical path remains under the root.
// 打开实际路径位于包根目录之内的普通文件。
export async function packageFile(root, relative) {
  portablePath(relative)
  const location = path.join(root, ...relative.split('/'))
  if (!(await lstat(location)).isFile()) throw new SkillError('invalid_path', `Expected a regular file: ${relative}`)
  const actual = await realpath(location)
  const local = path.relative(root, actual)
  if (!local || local === '..' || local.startsWith(`..${path.sep}`) || path.isAbsolute(local)) {
    throw new SkillError('invalid_path', `File escapes the package: ${relative}`)
  }
  return actual
}

// Inspect content in a stable order and reject links and case collisions.
// 按固定顺序检查包内容，拒绝链接和大小写冲突。
export async function treeDigest(root) {
  const hash = createHash('sha256')
  let total = 0
  let count = 0
  const walk = async (directory, prefix) => {
    const names = (await readdir(directory)).sort()
    const folded = new Set()
    for (const name of names) {
      const relative = portablePath(prefix + name)
      if (['.git', 'node_modules', '.venv', '__pycache__'].includes(name.toLowerCase())) {
        throw new SkillError('invalid_package', `Package contains preinstalled state: ${relative}`)
      }
      const comparable = name.normalize('NFC').toLowerCase()
      if (folded.has(comparable) || ++count > MAX_PACKAGE_ENTRIES) throw new SkillError('invalid_package', 'Duplicate path or too many entries.')
      folded.add(comparable)
      const file = path.join(directory, name)
      const metadata = await lstat(file)
      if (metadata.isDirectory()) {
        hash.update(JSON.stringify(['directory', relative]))
        await walk(file, relative + '/')
      } else if (metadata.isFile()) {
        total += metadata.size
        if (total > MAX_PACKAGE_BYTES) throw new SkillError('size_limit', 'Expanded package exceeds the permitted size.')
        const digest = createHash('sha256').update(await readFile(file)).digest('hex')
        hash.update(JSON.stringify(['file', relative, digest]))
      } else {
        throw new SkillError('invalid_package', `Unsupported filesystem object: ${relative}`)
      }
    }
  }
  await walk(root, '')
  return hash.digest('hex')
}
