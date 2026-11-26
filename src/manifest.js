import { readFile } from 'node:fs/promises'
import Ajv2020 from 'ajv/dist/2020.js'
import semver from 'semver'
import { createHash } from 'node:crypto'
import { packageFile, parseJson, SkillError } from './support.js'

const schema = parseJson(await readFile(new URL('../schemas/1.0.0/vulcan-skill.schema.json', import.meta.url), 'utf8'), 'protocol schema')
const schemaValidator = new Ajv2020({ strict: true, allErrors: true }).compile(schema)
export const PROTOCOL_VERSION = '1.0.0'

// Keep projected model tool names stable even when a tool is renamed for presentation.
// 在界面显示名称变化时保持模型接收的工具名稳定。
export function publicToolName(skillId, toolId) {
  const slug = `vs_${skillId.replaceAll(/[^a-z0-9]/g, '_')}_${toolId}`
  const suffix = createHash('sha256').update(JSON.stringify([skillId, toolId])).digest('hex').slice(0, 12)
  return `${slug.slice(0, 51)}_${suffix}`
}

// Check protocol admission before reading tool entries or preparing dependencies.
// 在读取工具入口或准备依赖之前检查协议兼容性。
function checkProtocol(manifest) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest) ||
    typeof manifest.id !== 'string' || semver.valid(manifest.version) === null || typeof manifest.protocol !== 'string') {
    throw new SkillError('invalid_manifest', 'The manifest must declare id, version and a package protocol range.')
  }
  let compatible = false
  for (const range of manifest.protocol.split(' || ')) {
    const endpoints = /^>=(\d+\.\d+\.\d+) <(\d+\.\d+\.\d+)$/.exec(range)
    if (!endpoints || endpoints[0] !== range || !semver.valid(endpoints[1]) || !semver.valid(endpoints[2]) ||
      !semver.lt(endpoints[1], endpoints[2]) || semver.gt(endpoints[2], `${semver.major(endpoints[1]) + 1}.0.0`)) {
      throw new SkillError('invalid_manifest', 'Protocol ranges must be bounded intervals within one major version.')
    }
    if (semver.satisfies(PROTOCOL_VERSION, range)) compatible = true
  }
  if (!compatible) throw new SkillError('protocol_unsupported', `This host implements protocol ${PROTOCOL_VERSION}; the package requires ${manifest.protocol}.`)
}

// Read, compile and validate one tool schema independently of all other tools.
// 独立读取、编译并校验一个工具的 Schema。
async function loadSchema(root, relative, input) {
  const value = parseJson(await readFile(await packageFile(root, relative), 'utf8'), relative)
  if (input && value?.type !== 'object') throw new SkillError('invalid_schema', `Input schema ${relative} must have an object root.`)
  try {
    return { value, validate: new Ajv2020({ strict: false, allErrors: true }).compile(value) }
  } catch (error) {
    throw new SkillError('invalid_schema', `Cannot compile ${relative}: ${error.message}`, { cause: error })
  }
}

// Resolve one immutable package and validate all declared files before registration.
// 解析不可变技能包并在注册前校验全部声明文件。
export async function loadPackage(root) {
  const manifest = parseJson(await readFile(await packageFile(root, 'vulcan-skill.json'), 'utf8'), 'vulcan-skill.json')
  checkProtocol(manifest)
  if (!schemaValidator(manifest)) {
    throw new SkillError('invalid_manifest', schemaValidator.errors.map(item => `${item.instancePath || '/'} ${item.message}`).join('; '))
  }
  const guide = manifest.guide ? await readFile(await packageFile(root, manifest.guide), 'utf8') : undefined
  if (guide !== undefined && !guide.trim()) throw new SkillError('invalid_manifest', 'SKILL.md is empty.')
  const tools = new Map()
  const languages = new Set()
  for (const tool of manifest.tools ?? []) {
    if (tools.has(tool.id)) throw new SkillError('duplicate_tool', `Duplicate tool id: ${tool.id}`)
    await packageFile(root, tool.entry)
    const input = await loadSchema(root, tool.inputSchema, true)
    const output = tool.outputSchema ? await loadSchema(root, tool.outputSchema, false) : undefined
    tools.set(tool.id, { tool, input, output, name: publicToolName(manifest.id, tool.id) })
    languages.add(tool.runtime)
  }
  for (const [language, declaration] of Object.entries(manifest.runtimes ?? {})) {
    if (!languages.has(language)) throw new SkillError('invalid_manifest', `Runtime ${language} has no tools.`)
    if (declaration.dependencies === 'locked') {
      const filenames = language === 'node' ? ['node/package.json', 'node/pnpm-lock.yaml'] : ['python/pyproject.toml', 'python/uv.lock']
      for (const file of filenames) await packageFile(root, file)
    }
  }
  return { manifest, guide, tools }
}
