import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import semver from 'semver'
import { extractTar, registryArchive } from './archive.js'
import { loadPackage, PROTOCOL_VERSION } from './manifest.js'
import { atomicJson, defaultHome, MAX_PACKAGE_BYTES, parseJson, registryUrl, SkillError, treeDigest, withLock } from './support.js'

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'
const NPM_SPEC = /^npm:((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@([^@]+)$/

// Return a package's selected mode without consulting inherited object keys.
// 返回包内工具的生效模式，排除对象继承字段。
export function toolMode(record, tool) {
  return Object.hasOwn(record.modes, tool.id) ? record.modes[tool.id] : tool.invocation
}

// Manage installed package generations and host-wide registry settings.
// 管理已安装包的代次与宿主级 Registry 设置。
export class SkillStore {
  constructor(home = defaultHome()) {
    this.home = path.resolve(home)
    this.stateFile = path.join(this.home, 'skills.json')
  }

  // Read one complete published catalog revision.
  // 读取一份完整发布的目录版本。
  async state() {
    let state
    try {
      state = parseJson(await readFile(this.stateFile, 'utf8'), this.stateFile)
    } catch (error) {
      if (error.code === 'ENOENT') return { format: 1, registry: DEFAULT_REGISTRY, skills: {} }
      throw error
    }
    if (state?.format !== 1 || typeof state.registry !== 'string' || !state.skills || Array.isArray(state.skills) ||
      typeof state.skills !== 'object') throw new SkillError('invalid_state', 'Unsupported installed catalog format.')
    return state
  }

  // Change the registry used by subsequent explicit installs and dependency resolution.
  // 修改后续显式安装和依赖解析使用的 Registry。
  async setRegistry(value) {
    const registry = registryUrl(value).href
    await this.mutate(state => { state.registry = registry })
    return registry
  }

  // Publish a verified immutable package from a directory, npm tarball, or registry.
  // 从目录、npm 归档或 Registry 发布已验证的不可变技能包。
  async install(source, registryOverride) {
    await mkdir(this.home, { recursive: true })
    const stage = await mkdtemp(path.join(this.home, '.install-'))
    try {
      const spec = NPM_SPEC.exec(source)
      let installedFrom
      if (source.startsWith('npm:')) {
        if (!spec || spec[0] !== source || !semver.valid(spec[2]) || !/^[0-9]/.test(spec[2])) {
          throw new SkillError('invalid_source', 'Use npm:<name>@<exact-version> to install from a registry.')
        }
        const registry = registryUrl(registryOverride ?? (await this.state()).registry)
        const archive = await registryArchive(spec[1], spec[2], registry)
        await extractTar(archive, stage, 'package')
        installedFrom = { kind: 'npm', name: spec[1], registry: registry.href, version: spec[2] }
      } else {
        const file = await realpath(source)
        const info = await stat(file)
        if (info.isDirectory()) {
          const sourceDigest = await treeDigest(file)
          await cp(file, stage, { recursive: true, verbatimSymlinks: true })
          if (await treeDigest(stage) !== sourceDigest) throw new SkillError('source_changed', 'Skill directory changed during install.')
        } else {
          if (!info.isFile() || !file.endsWith('.tgz') || info.size > MAX_PACKAGE_BYTES) throw new SkillError('invalid_source', 'Install a prepared skill directory or npm .tgz.')
          await extractTar(await readFile(file), stage, 'package')
        }
        installedFrom = { kind: 'local', path: file }
      }
      const root = await realpath(stage)
      const { manifest } = await loadPackage(root)
      if (spec && manifest.version !== spec[2]) throw new SkillError('version_mismatch', 'npm version and VulcanSkills version must agree.')
      const digest = await treeDigest(root)
      return await this.mutate(async state => {
        const previous = state.skills[manifest.id]
        if (previous?.source.kind === 'npm' &&
          (installedFrom.kind !== 'npm' || previous.source.name !== installedFrom.name || previous.source.registry !== installedFrom.registry)) {
          throw new SkillError('source_mismatch', 'The installed skill is bound to a different npm source.')
        }
        if (previous && semver.lt(manifest.version, previous.version)) throw new SkillError('version_mismatch', 'Installed skills cannot be downgraded by install.')
        const generation = path.join(this.home, 'packages', manifest.id, manifest.version)
        await mkdir(path.dirname(generation), { recursive: true })
        try {
          if (await treeDigest(generation) !== digest) throw new SkillError('version_conflict', 'This package version was already published with different contents.')
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
          await rename(stage, generation)
        }
        const modes = {}
        for (const tool of manifest.tools ?? []) {
          const prior = previous?.modes[tool.id]
          if (prior === 'explicit' || (prior === 'implicit' && manifest.guide)) modes[tool.id] = prior
        }
        const record = {
          id: manifest.id, version: manifest.version, name: manifest.name, description: manifest.description,
          protocol: PROTOCOL_VERSION, digest, source: installedFrom, enabled: previous?.enabled ?? true, modes,
        }
        state.skills[record.id] = record
        return record
      })
    } finally {
      await rm(stage, { recursive: true, force: true })
    }
  }

  // Stop or restore tool exposure without rewriting package files.
  // 停止或恢复工具暴露，保持技能包文件不变。
  async setEnabled(id, enabled) {
    return this.mutate(state => {
      const record = this.find(state, id)
      record.enabled = enabled
      return record
    })
  }

  // Remove an installed record while leased immutable assets remain cached.
  // 移除安装记录，保留可能仍被执行租用的不可变缓存。
  async uninstall(id) {
    return this.mutate(state => {
      const record = this.find(state, id)
      delete state.skills[id]
      return record
    })
  }

  // Persist a user override for one tool after validating guide availability.
  // 在校验指引可用后保存单个工具的用户调用模式。
  async setMode(id, toolId, mode) {
    if (!['explicit', 'implicit', 'default'].includes(mode)) throw new SkillError('invalid_mode', 'Expected explicit, implicit or default.')
    return this.mutate(async state => {
      const record = this.find(state, id)
      const { guide, tools } = await this.open(record)
      if (!tools.has(toolId)) throw new SkillError('tool_not_found', `Unknown tool: ${toolId}`)
      if (mode === 'implicit' && guide === undefined) throw new SkillError('invalid_mode', 'Implicit tools require SKILL.md.')
      if (mode === 'default') delete record.modes[toolId]
      else record.modes[toolId] = mode
      return record
    })
  }

  // Resolve one installed record in the already captured catalog.
  // 从已捕获的目录中解析一条安装记录。
  find(state, id) {
    if (typeof id !== 'string' || !Object.hasOwn(state.skills, id)) throw new SkillError('skill_not_found', `Skill is not installed: ${id}`)
    return state.skills[id]
  }

  // Load the exact generation selected by this record.
  // 加载安装记录固定的准确包代次。
  async open(record) {
    const root = await realpath(path.join(this.home, 'packages', record.id, record.version))
    return { root, ...await loadPackage(root) }
  }

  // Publish one update while retaining concurrent unrelated changes.
  // 发布一项更新，同时保留并发的无关修改。
  async mutate(change) {
    return withLock(this.home, async () => {
      const state = await this.state()
      const result = await change(state)
      await atomicJson(this.stateFile, state)
      return result
    })
  }
}
