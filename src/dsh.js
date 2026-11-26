import { createHash, randomUUID } from 'node:crypto'
import { watch } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { SkillStore, toolMode } from './store.js'
import { SkillRuntime } from './runtime.js'
import { SkillError } from './support.js'

export const name = 'vulcan-skills'
export const inject = ['skills', 'tools', 'workingDirectory', 'sandbox', 'sandboxPolicy', 'subprocess']
const DISPATCHER = 'vulcan_skills_call'

// Map stable package identities to DSH-compatible instruction names.
// 将稳定的技能包身份映射到兼容 DSH 的指引名称。
function guideName(id) {
  const suffix = createHash('sha256').update(id).digest('hex').slice(0, 10)
  return `vs-${id.replaceAll('.', '-').slice(0, 48)}-${suffix}`
}

// Render ordinary JSON values without coercing the recorded value to text.
// 渲染普通 JSON 值，同时保留记录中的结构化值。
const output = {
  schema: {},
  render(_args, value) {
    return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
  },
}

// Adopt the restricted host's real process handle and wait for tree termination.
// 使用受限宿主的实际进程句柄，并等待进程树终止。
async function spawnConfined(ctx, policy, argv, options) {
  const command = policy.mode === 'danger-full-access' ? argv : (await ctx.sandbox.confine(argv, policy, options.signal)).argv
  options.signal.throwIfAborted()
  const env = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]))
  Object.assign(env, options.env)
  // The Windows ACL launcher can use the Desktop host executable as its Node interpreter.
  // Windows ACL 启动器可以使用桌面宿主的可执行文件作为 Node 解释器。
  if (process.versions.electron && command[0] === process.execPath) env.ELECTRON_RUN_AS_NODE = '1'
  const handle = ctx.subprocess.spawn({
    argv: command, cwd: options.cwd, env, graceMs: 1_000,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  })
  const done = handle.done.then(({ exitCode, signal }) => ({ code: exitCode, signal })).finally(() => handle.waitForExit())
  if (!handle.stdin || !handle.stdout || !handle.stderr) {
    handle.terminate()
    await done
    throw new SkillError('worker_unavailable', 'DSH did not connect every worker stream.')
  }
  return {
    stdin: handle.stdin, stdout: handle.stdout, stderr: handle.stderr,
    done,
    terminate: () => handle.terminate(),
  }
}

// Build a DSH definition for the exact tool name and contents that were advertised.
// 为已暴露的准确工具名称和内容构建 DSH 定义。
function definition(ctx, runtime, record, binding, mode) {
  return {
    name: binding.name, description: binding.tool.description, parameters: binding.input.value, output,
    async execute(args, exec) {
      if (!exec.agent) throw new SkillError('missing_session', 'VulcanSkills needs a calling session.')
      const session = exec.agent.session
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      const policy = ctx.sandboxPolicy.resolve({ session })
      return runtime.call(record.id, binding.tool.id, args, {
        digest: record.digest, mode, cwd, signal: exec.signal,
        partition: JSON.stringify([session.id, policy]),
        spawnProcess: (argv, options) => spawnConfined(ctx, policy, argv, options),
      })
    },
  }
}

// Mount the common store and the native DSH agent/tool integration.
// 挂载共用技能仓库和 DSH 原生工具集成。
export function apply(ctx) {
  const store = new SkillStore()
  const runtime = new SkillRuntime(store)
  const active = new Map()
  let guides = new Map()
  let refresh = Promise.resolve()
  let closed = false
  let watcher
  let timer
  let invalidate
  let pipeline
  let disposeDispatcher

  // Expose guides without starting runtime languages or installing dependencies.
  // 公布使用指引，不为列举动作启动解释器或安装依赖。
  const disposeGuides = ctx.skills.registerProvider(control => {
    invalidate = () => control.invalidate()
    return {
      name,
      async list() {
        await refresh
        return [...guides.values()].map(item => item.candidate)
      },
      async get(candidate) {
        const item = guides.get(candidate.name)
        if (!item || item.candidate.locator !== candidate.locator) return undefined
        const { rank: _rank, locator: _locator, ...summary } = item.candidate
        return { ...summary, content: item.content }
      },
    }
  })

  // Repeat the normal DSH policy pipeline for the actual hidden action.
  // 对真正执行的隐式动作重新运行 DSH 常规策略链。
  const dispatcher = {
    name: DISPATCHER,
    description: 'Run an implicit VulcanSkills action. Load the matching skill guide first and follow its argument schema.',
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['skill', 'action', 'arguments'],
      properties: { skill: { type: 'string' }, action: { type: 'string' }, arguments: { type: 'object' } },
    },
    output,
    async execute(args, exec) {
      await refresh
      const guide = guides.get(args.skill)
      if (!guide || !exec.agent) throw new SkillError('tool_not_found', 'Skill guide is not available.')
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      const visible = await ctx.skills.list({ scope: exec.agent, cwd, signal: exec.signal })
      const target = guide.hidden.get(args.action)
      if (!target || guides.get(args.skill) !== guide || !visible.some(item =>
        item.name === args.skill && item.provider === name && item.path === guide.candidate.path && item.invocation.modelInvocable) ||
        ctx.tools.get(target.name, exec.agent) !== undefined) {
        throw new SkillError('tool_not_found', 'Implicit action is not available in this session.')
      }
      const Pipeline = await (pipeline ??= import('@deepseek-ai/dsh-tools/pipeline').then(module => module.ToolExecutionPipeline))
      const runner = new Pipeline(ctx, { get: candidate => candidate === target.name ? target : undefined })
      const prepare = await runner.prepare({
        callId: randomUUID(), rootCallId: exec.rootCallId, parent: exec.token, agent: exec.agent,
        name: target.name, arguments: args.arguments, signal: exec.signal, toolSet: exec.toolSet,
      })
      const outcome = prepare.kind === 'dispatch' ? await runner.dispatch(prepare.exec) : prepare
      const result = await runner.complete(prepare.exec, outcome)
      for (const message of result.additionalContexts ?? []) exec.deferContext(message)
      if (result.isError) throw new SkillError(result.error?.code ?? 'skill_failed', result.error?.message ?? 'Implicit action failed.')
      if (result.concludesTurn) exec.concludeTurn()
      return result.value
    },
  }

  // Load a complete catalog revision and update only changed tool registrations.
  // 加载完整目录版本，只更新发生变化的工具注册。
  async function load() {
    const nextGuides = new Map()
    const nextTools = new Map()
    const state = await store.state()
    for (const record of Object.values(state.skills)) {
      if (!record.enabled) continue
      const pkg = await store.open(record)
      const hidden = new Map()
      const guidance = []
      for (const binding of pkg.tools.values()) {
        const mode = toolMode(record, binding.tool)
        const tool = definition(ctx, runtime, record, binding, mode)
        if (mode === 'explicit') {
          if (nextTools.has(tool.name) || (!active.has(tool.name) && ctx.tools.get(tool.name) !== undefined)) {
            throw new SkillError('duplicate_tool', `Tool name already owned: ${tool.name}`)
          }
          nextTools.set(tool.name, { digest: record.digest, tool })
          guidance.push(`- \`${tool.name}\`: ${tool.description}`)
        } else {
          hidden.set(binding.tool.id, tool)
          guidance.push(`- \`${binding.tool.id}\`: ${tool.description}\n  Arguments: \`${JSON.stringify(tool.parameters)}\``)
        }
      }
      if (pkg.guide !== undefined) {
        const guide = guideName(record.id)
        const file = path.join(pkg.root, 'SKILL.md')
        nextGuides.set(guide, {
          hidden,
          candidate: { name: guide, description: record.description, path: file, locator: record.digest, provider: name,
            source: name, rank: 10, invocation: { modelInvocable: true, userInvocable: true },
            resourceBase: { kind: 'directory', path: pkg.root } },
          content: [pkg.guide, hidden.size ? `Implicit actions use \`${DISPATCHER}\` with skill \`${guide}\`, action, and arguments.` : '', ...guidance].join('\n\n'),
        })
      }
    }
    if (closed) return
    for (const [toolName, old] of active) {
      if (nextTools.get(toolName)?.digest === old.digest) continue
      old.dispose()
      active.delete(toolName)
    }
    for (const [toolName, item] of nextTools) {
      if (!active.has(toolName)) active.set(toolName, { digest: item.digest, dispose: ctx.tools.register(item.tool) })
    }
    if ([...nextGuides.values()].some(guide => guide.hidden.size > 0)) {
      disposeDispatcher ??= ctx.tools.register(dispatcher)
    } else if (disposeDispatcher !== undefined) {
      disposeDispatcher()
      disposeDispatcher = undefined
    }
    guides = nextGuides
    invalidate?.()
  }

  // Serialize filesystem-triggered refreshes so an old read cannot publish last.
  // 串行处理文件变更触发的刷新，避免旧读取后发布。
  function schedule() {
    refresh = refresh.then(load).catch(error => ctx.logger.warn(`VulcanSkills catalog: ${error.message}`))
  }

  ctx.effect(() => {
    refresh = mkdir(store.home, { recursive: true }).then(() => {
      if (closed) return
      watcher = watch(store.home, (_event, file) => {
        if (file !== null && file !== 'skills.json') return
        clearTimeout(timer)
        timer = setTimeout(schedule, 75)
      })
      watcher.on('error', error => ctx.logger.warn(`VulcanSkills catalog watcher: ${error.message}`))
      return load()
    }).catch(error => ctx.logger.warn(`VulcanSkills catalog: ${error.message}`))
    return async () => {
      closed = true
      clearTimeout(timer)
      watcher?.close()
      disposeDispatcher?.()
      disposeGuides()
      for (const entry of active.values()) entry.dispose()
      active.clear()
      await runtime.close()
    }
  }, 'vulcan-skills runtime')
}
