import path from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

// Reserve stdout for protocol frames while normal module logging goes to stderr.
// 保留 stdout 用于协议帧，将普通模块日志发往 stderr。
const reply = process.stdout.write.bind(process.stdout)
process.stdout.write = (...args) => process.stderr.write(...args)
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })

for await (const line of lines) {
  const request = JSON.parse(line)
  try {
    const module = await import(pathToFileURL(path.resolve(request.entry)).href)
    const run = module[request.export]
    if (typeof run !== 'function') throw new Error(`No callable export ${request.export}`)
    const value = await run(request.args, request.context)
    reply('\nVS1 ' + JSON.stringify({ id: request.id, ok: true, value: value ?? null }) + '\n')
  } catch (error) {
    reply('\nVS1 ' + JSON.stringify({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }) + '\n')
  }
}
