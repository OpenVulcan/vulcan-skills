import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Environments } from './dependencies.js'
import { childEnvironment, spawnLocal } from './process.js'
import { toolMode } from './store.js'
import { SkillError } from './support.js'
import { WorkerPool } from './worker-pool.js'

const RUNNERS = {
  node: fileURLToPath(new URL('./node-worker.mjs', import.meta.url)),
  python: fileURLToPath(new URL('./python-worker.py', import.meta.url)),
}

// Route approved calls to exact immutable package generations and worker partitions.
// 将已授权调用分发到精确的不可变包代次与 Worker 分区。
export class SkillRuntime {
  constructor(store, { environments = new Environments(store.home), pool = new WorkerPool() } = {}) {
    this.store = store
    this.environments = environments
    this.pool = pool
    this.lifecycle = new AbortController()
  }

  // Revalidate catalog, arguments and runtime identity at the execution boundary.
  // 在执行边界再次校验目录、参数和运行时身份。
  async call(id, toolId, args, options = {}) {
    const deadline = AbortSignal.timeout(300_000)
    const signal = AbortSignal.any([deadline, this.lifecycle.signal, ...(options.signal ? [options.signal] : [])])
    signal.throwIfAborted()
    const state = await this.store.state()
    const record = this.store.find(state, id)
    if (!record.enabled) throw new SkillError('skill_disabled', `Skill is disabled: ${id}`)
    if (options.digest && options.digest !== record.digest) throw new SkillError('skill_changed', 'The skill changed after tool resolution.')
    const pkg = { record, ...await this.store.open(record) }
    const binding = pkg.tools.get(toolId)
    if (!binding) throw new SkillError('tool_not_found', `Unknown tool: ${toolId}`)
    if (options.mode && toolMode(record, binding.tool) !== options.mode) throw new SkillError('skill_changed', 'The tool invocation mode changed.')
    if (!binding.input.validate(args)) throw new SkillError('invalid_arguments', JSON.stringify(binding.input.validate.errors))
    const workspace = await realpath(options.cwd ?? process.cwd())
    const language = binding.tool.runtime
    const environment = await this.environments.resolve(pkg, language, state.registry, signal)
    const key = createHash('sha256').update(JSON.stringify([
      record.digest, language, environment.interpreter, environment.root, workspace, options.partition ?? 'local-user',
    ])).digest('hex')
    const launch = options.spawnProcess ?? spawnLocal
    const runnerArgs = language === 'python' ? ['-I', '-X', 'utf8', '-B', '-u'] : []
    const admit = async () => {
      const current = this.store.find(await this.store.state(), id)
      if (!current.enabled || current.digest !== record.digest || toolMode(current, binding.tool) !== toolMode(record, binding.tool)) {
        throw new SkillError('skill_changed', 'The tool changed while waiting for a worker.')
      }
    }
    const value = await this.pool.run(key, () => launch([environment.interpreter, ...runnerArgs, RUNNERS[language]], {
      cwd: workspace, env: childEnvironment({ PYTHONIOENCODING: 'utf-8' }), signal,
    }), {
      entry: path.join(environment.root, binding.tool.entry), export: binding.tool.export,
      moduleRoot: path.join(environment.root, language), args,
      context: { workspace, skillId: id, toolId, packageRoot: pkg.root },
    }, signal, admit)
    if (binding.output && !binding.output.validate(value)) throw new SkillError('invalid_result', JSON.stringify(binding.output.validate.errors))
    return value
  }

  // Stop runtime preparation and active workers at host disposal.
  // 在宿主释放时终止运行环境准备和当前 Worker。
  async close() {
    this.lifecycle.abort(new SkillError('runtime_closed', 'Skill runtime closed.'))
    await this.pool.close()
  }
}
