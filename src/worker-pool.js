import { randomUUID } from 'node:crypto'
import { SkillError } from './support.js'

const MAX_FRAME = 4 * 1024 * 1024
const MAX_QUEUE = 64
const MAX_WORKERS = 4
const PER_KEY = 2
const IDLE_TIMEOUT = 60_000
const MAX_CALLS = 100
const WORKER_REPLY = 'VS1 '

// Associate each reply with its single in-flight request and discard broken workers.
// 将响应关联到唯一正在执行的请求，并淘汰失效的 Worker。
export class SkillWorker {
  constructor(child) {
    this.child = child
    this.pending = undefined
    this.unparsed = ''
    this.exited = false
    this.calls = 0
    this.stderr = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => this.receive(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-3000) })
    child.stdin.on('error', error => this.break(error))
    this.done = child.done.then(
      outcome => this.finish(new SkillError('worker_exited', `Skill worker exited (${outcome.code ?? outcome.signal}). ${this.stderr}`)),
      error => this.finish(error),
    )
  }

  // Parse newline-delimited responses without allowing unbounded buffering.
  // 解析以换行符分隔的响应，并限制缓冲大小。
  receive(chunk) {
    if (this.exited) return
    this.unparsed += chunk
    if (Buffer.byteLength(this.unparsed) > MAX_FRAME) {
      this.break(new SkillError('size_limit', 'A skill worker response exceeded its budget.'))
      return
    }
    // Sandbox launchers may emit terminal output on the same pipe before the worker starts.
    // 沙盒启动器可能会在 Worker 启动前经同一管道输出终端日志。
    for (let end = this.unparsed.indexOf('\n'); end !== -1; end = this.unparsed.indexOf('\n')) {
      const line = this.unparsed.slice(0, end)
      this.unparsed = this.unparsed.slice(end + 1)
      if (!line.startsWith(WORKER_REPLY)) continue
      const pending = this.pending
      try {
        const frame = JSON.parse(line.slice(WORKER_REPLY.length))
        if (!pending || frame?.id !== pending.id || typeof frame.ok !== 'boolean') {
          throw new SkillError('invalid_worker_response', 'A worker sent an unexpected response.')
        }
        this.pending = undefined
        pending.cleanup()
        if (frame.ok) pending.resolve(frame.value ?? null)
        else pending.reject(new SkillError('skill_failed', String(frame.error).slice(0, 3000)))
      } catch (error) {
        this.break(error)
        return
      }
    }
  }

  // Run one request; cancelling it retires this process and all of its state.
  // 执行一次请求；取消时退役整个进程及其中的状态。
  async call(message, signal) {
    signal.throwIfAborted()
    if (this.exited || this.pending) throw new SkillError('worker_unavailable', 'Skill worker is not available.')
    const id = randomUUID()
    const frame = JSON.stringify({ id, ...message }) + '\n'
    if (Buffer.byteLength(frame) > MAX_FRAME) throw new SkillError('size_limit', 'Skill arguments exceed the worker request limit.')
    this.calls++
    return new Promise((resolve, reject) => {
      const abort = () => this.break(signal.reason)
      this.pending = { id, resolve, reject, cleanup: () => signal.removeEventListener('abort', abort) }
      signal.addEventListener('abort', abort, { once: true })
      this.child.stdin.write(frame, error => { if (error) this.break(error) })
    })
  }

  // Reject the current request exactly once when the process ails.
  // 进程失败时仅拒绝当前请求一次。
  finish(error) {
    this.exited = true
    const pending = this.pending
    this.pending = undefined
    pending?.cleanup()
    pending?.reject(error)
  }

  // Stop the owned process and seal its protocol stream.
  // 终止归属进程并关闭其协议流。
  break(error) {
    if (this.exited) return
    this.finish(error)
    this.child.terminate()
  }

  // Wait for process settlement before releasing capacity.
  // 等待进程收尾再释放容量。
  async stop() {
    this.break(new SkillError('worker_stopped', 'Skill worker stopped.'))
    await this.done
  }
}

// Schedule isolated processes against one local concurrency budget.
// 按单一本机并发预算调度隔离进程。
export class WorkerPool {
  slots = new Set()
  queue = []
  closed = false

  // Enqueue one bounded request and propagate caller cancellation.
  // 排入一项有界请求并传递调用方取消。
  async run(key, start, message, signal, admit) {
    signal.throwIfAborted()
    if (this.closed || this.queue.length >= MAX_QUEUE) throw new SkillError('pool_busy', 'Skill worker queue is unavailable or full.')
    return new Promise((resolve, reject) => {
      const item = { key, start, message, signal, admit, resolve, reject, dequeue: () => signal.removeEventListener('abort', abort) }
      const abort = () => {
        const index = this.queue.indexOf(item)
        if (index >= 0) this.queue.splice(index, 1)
        reject(signal.reason)
      }
      signal.addEventListener('abort', abort, { once: true })
      this.queue.push(item)
      this.pump()
    })
  }

  // Reuse exact workers or reserve capacity before starting a replacement.
  // 复用精确匹配的 Worker，或先预留容量再启动新实例。
  pump() {
    if (this.closed) return
    for (let index = 0; index < this.queue.length;) {
      const request = this.queue[index]
      let slot = [...this.slots].find(item => item.key === request.key && item.state === 'idle' && !item.worker.exited)
      if (!slot) {
        if ([...this.slots].filter(item => item.key === request.key).length >= PER_KEY) {
          index++
          continue
        }
        if (this.slots.size >= MAX_WORKERS) {
          const idle = [...this.slots].find(item => item.state === 'idle')
          if (idle) void this.retire(idle)
          break
        }
        slot = { key: request.key, state: 'busy' }
        this.slots.add(slot)
      }
      this.queue.splice(index, 1)
      request.dequeue()
      clearTimeout(slot.timer)
      slot.state = 'busy'
      slot.work = this.execute(slot, request)
    }
  }

  // Release healthy workers and drain all other states before reuse.
  // 归还健康 Worker，其他状态在复用前完整清理。
  async execute(slot, request) {
    let value
    let failure
    let failed = false
    try {
      request.signal.throwIfAborted()
      await request.admit()
      request.signal.throwIfAborted()
      if (!slot.worker) {
        slot.worker = new SkillWorker(await request.start())
        await request.admit()
      }
      value = await slot.worker.call(request.message, request.signal)
    } catch (error) {
      failed = true
      failure = error
    } finally {
      if (this.closed || !slot.worker || slot.worker.exited || slot.worker.calls >= MAX_CALLS || request.signal.aborted) {
        await this.retire(slot)
      } else {
        slot.state = 'idle'
        slot.timer = setTimeout(() => { void this.retire(slot) }, IDLE_TIMEOUT)
        slot.timer.unref()
        this.pump()
      }
    }
    if (failed) request.reject(failure)
    else request.resolve(value)
  }

  // Retire a slot without freeing its budget before the child settles.
  // 退役实例时保留预算，直到子进程真正结束。
  async retire(slot) {
    if (slot.retirement) return slot.retirement
    if (!this.slots.has(slot)) return
    slot.state = 'closing'
    clearTimeout(slot.timer)
    slot.retirement = (async () => {
      try { await slot.worker?.stop() } finally {
        this.slots.delete(slot)
        this.pump()
      }
    })()
    return slot.retirement
  }

  // Stop intake, reject queued calls and close owned processes.
  // 停止接单、拒绝排队调用并关闭归属进程。
  async close() {
    this.closed = true
    for (const request of this.queue.splice(0)) {
      request.dequeue()
      request.reject(new SkillError('pool_closed', 'Skill worker pool closed.'))
    }
    const slots = [...this.slots]
    for (const slot of slots) slot.worker?.break(new SkillError('pool_closed', 'Skill worker pool closed.'))
    await Promise.all(slots.map(async slot => {
      await slot.work
      await this.retire(slot)
    }))
  }
}
