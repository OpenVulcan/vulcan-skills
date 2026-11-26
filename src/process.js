import { spawn } from 'node:child_process'
import path from 'node:path'
import { SkillError } from './support.js'

// Pass platform plumbing without inheriting provider credentials or interpreter hooks.
// 保留平台所需环境变量，排除供应商凭据和解释器启动钩子。
export function childEnvironment(extra = {}) {
  const environment = {}
  const names = new Set(['path', 'pathext', 'systemroot', 'windir', 'comspec', 'temp', 'tmp', 'tmpdir', 'lang', 'lc_all'])
  for (const [key, value] of Object.entries(process.env)) {
    if (names.has(key.toLowerCase())) environment[key] = value
  }
  return { ...environment, ...extra }
}

// Spawn without shell evaluation and expose one settlement and termination path.
// 直接启动进程而不解释 shell，并提供统一的结束和终止接口。
export function spawnLocal(argv, options) {
  const windows = process.platform === 'win32'
  const child = spawn(argv[0], argv.slice(1), {
    cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true, detached: !windows,
  })
  child.stdin.on('error', () => {})
  const done = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  const terminate = () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
    if (windows) {
      const tool = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
      const killer = spawn(tool, ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
      killer.once('error', () => child.kill())
      killer.once('exit', code => { if (code !== 0) child.kill() })
    } else {
      try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
        if (error.code !== 'ESRCH') child.kill('SIGKILL')
      }
    }
  }
  return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, done, terminate }
}

// Collect bounded diagnostics from a provisioning command.
// 收集准备运行环境命令的有界诊断信息。
export async function runCommand(argv, { cwd, env, signal = AbortSignal.timeout(600_000), spawnProcess = spawnLocal }) {
  signal.throwIfAborted()
  const child = await spawnProcess(argv, { cwd, env })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-65_536) })
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-65_536) })
  child.stdin.end()
  const stop = () => child.terminate()
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()
  try {
    const outcome = await child.done
    signal.throwIfAborted()
    if (outcome.code !== 0) throw new SkillError('process_failed', `${path.basename(argv[0])} exited with ${outcome.code ?? outcome.signal}: ${stderr.trim().slice(-3000)}`)
    return stdout.trim()
  } finally {
    signal.removeEventListener('abort', stop)
  }
}
