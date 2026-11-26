import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { x as unpack } from 'tar'
import { download, MAX_PACKAGE_BYTES, MAX_PACKAGE_ENTRIES, parseJson, portablePath, SkillError } from './support.js'

// Validate extraction names and aggregate declared output sizes.
// 校验解包路径和归档所声明的总输出大小。
function extractionGuard(root) {
  const entries = new Set()
  let bytes = 0
  return (name, size) => {
    const clean = name.replace(/\/$/, '')
    if (clean === root) return false
    if (!clean.startsWith(`${root}/`)) throw new SkillError('invalid_package', `Archive entry outside ${root}: ${name}`)
    const relative = portablePath(clean.slice(root.length + 1))
    const key = relative.normalize('NFC').toLowerCase()
    bytes += size
    if (entries.has(key) || entries.size === MAX_PACKAGE_ENTRIES || bytes > MAX_PACKAGE_BYTES) {
      throw new SkillError('invalid_package', 'Archive contains a duplicate path or exceeds the extraction budget.')
    }
    entries.add(key)
    return true
  }
}

// Extract a regular-file tarball with a single named root.
// 解包只有普通文件和指定根目录的 tar 归档。
export async function extractTar(buffer, directory, root) {
  const scratch = await mkdtemp(path.join(tmpdir(), 'vulcan-skills-tar-'))
  const file = path.join(scratch, 'package.tgz')
  const admit = extractionGuard(root)
  let invalid
  try {
    await writeFile(file, buffer)
    await unpack({
      file, cwd: directory, strip: 1, strict: true, noChmod: true,
      filter(name, entry) {
        if (invalid) return false
        try {
          if (!['Directory', 'File', 'OldFile'].includes(entry.type)) throw new SkillError('invalid_package', `Unsupported archive entry: ${entry.type}`)
          return admit(name, entry.size)
        } catch (error) {
          invalid = error
          return false
        }
      },
    })
    if (invalid) throw invalid
  } finally {
    await rm(scratch, { force: true, recursive: true })
  }
}

// Download an exact registry version and verify its published SHA-512 integrity.
// 下载 Registry 中的精确版本并按发行记录校验 SHA-512。
export async function registryArchive(name, version, registry, signal) {
  const metadataUrl = new URL(`${encodeURIComponent(name)}/${encodeURIComponent(version)}`, registry)
  const metadata = parseJson((await download(metadataUrl, 4 * 1024 * 1024, signal)).toString('utf8'), metadataUrl.pathname)
  if (metadata.name !== name || metadata.version !== version || typeof metadata.dist?.tarball !== 'string' ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(metadata.dist.integrity)) {
    throw new SkillError('invalid_source', 'Registry must publish an exact version with SHA-512 integrity.')
  }
  const url = new URL(metadata.dist.tarball)
  if (url.origin !== registry.origin || !url.pathname.startsWith(registry.pathname) || url.username || url.password) {
    throw new SkillError('invalid_source', 'Registry tarball leaves the configured registry.')
  }
  const buffer = await download(url, MAX_PACKAGE_BYTES, signal)
  const integrity = `sha512-${createHash('sha512').update(buffer).digest('base64')}`
  if (integrity !== metadata.dist.integrity) throw new SkillError('integrity_mismatch', 'Registry tarball does not match its SHA-512 integrity.')
  return buffer
}
