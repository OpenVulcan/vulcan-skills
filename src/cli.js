#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { SkillStore, toolMode } from './store.js'
import { SkillRuntime } from './runtime.js'
import { parseJson, SkillError } from './support.js'

const HELP = `vulcan-skills <command>
  install <directory | archive.tgz | npm:name@version> [--registry <url>]
  list
  show <skill-id>
  enable <skill-id>
  disable <skill-id>
  uninstall <skill-id>
  mode <skill-id> <tool-id> <explicit | implicit | default>
  registry [url]
  run <skill-id> <tool-id> --args '<JSON>' [--cwd <directory>]`

// Dispatch commands entered directly by the local user.
// 分发本机用户直接输入的管理命令。
async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { home: { type: 'string' }, registry: { type: 'string' }, args: { type: 'string' }, cwd: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  })
  if (values.help || !positionals.length) return process.stdout.write(HELP + '\n')
  const [command, first, second, third] = positionals
  const counts = { install: 2, list: 1, show: 2, enable: 2, disable: 2, uninstall: 2, mode: 4, run: 3 }
  if (command === 'registry' ? positionals.length > 2 : !Object.hasOwn(counts, command) || counts[command] !== positionals.length) {
    throw new SkillError('invalid_command', HELP)
  }
  const store = new SkillStore(values.home)
  let result
  switch (command) {
    case 'install': result = await store.install(first, values.registry); break
    case 'list': result = Object.values((await store.state()).skills); break
    case 'show': {
      const record = store.find(await store.state(), first)
      const pkg = await store.open(record)
      result = { ...record, guide: pkg.guide, tools: [...pkg.tools.values()].map(({ tool, name }) => ({ ...tool, name, invocation: toolMode(record, tool) })) }
      break
    }
    case 'enable':
    case 'disable': result = await store.setEnabled(first, command === 'enable'); break
    case 'uninstall': result = await store.uninstall(first); break
    case 'mode': result = await store.setMode(first, second, third); break
    case 'registry': result = first === undefined ? (await store.state()).registry : await store.setRegistry(first); break
    case 'run': {
      const ctrl = new AbortController()
      const stop = () => ctrl.abort(new SkillError('cancelled', 'Skill command cancelled.'))
      const runtime = new SkillRuntime(store)
      process.once('SIGINT', stop)
      try {
        result = await runtime.call(first, second, parseJson(values.args ?? '{}', '--args'), { cwd: values.cwd, signal: ctrl.signal })
      } finally {
        process.removeListener('SIGINT', stop)
        await runtime.close()
      }
      break
    }
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
}

main().catch(error => {
  process.stderr.write(`[${error.code ?? 'error'}] ${error.message}\n`)
  process.exitCode = 1
})
