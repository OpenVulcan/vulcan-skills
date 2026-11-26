import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { c as pack } from 'tar'
import { SkillRuntime } from '../src/runtime.js'
import { SkillStore, toolMode } from '../src/store.js'

// Construct a real mixed-language package in an isolated test directory.
// 在隔离测试目录内创建真实的多语言技能包。
async function fixture(t, beforeCleanup = async () => {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'vulcan-skills-v1-'))
  t.after(async () => {
    await beforeCleanup()
    await rm(root, { recursive: true, force: true })
  })
  const source = path.join(root, 'package')
  await Promise.all(['node/dist', 'python', 'schemas'].map(directory => mkdir(path.join(source, directory), { recursive: true })))
  const manifest = {
    id: 'test.echo', version: '1.0.0', protocol: '>=1.0.0 <2.0.0', name: 'Echo', description: 'Test worker routing.',
    guide: 'SKILL.md', runtimes: { node: { dependencies: 'none' }, python: { dependencies: 'none' } },
    tools: [
      { id: 'echo', description: 'Echo from Node.', runtime: 'node', entry: 'node/dist/echo.mjs', export: 'run',
        invocation: 'explicit', inputSchema: 'schemas/input.json', outputSchema: 'schemas/output.json' },
      { id: 'echo_python', description: 'Echo from Python.', runtime: 'python', entry: 'python/echo.py', export: 'run',
        invocation: 'implicit', inputSchema: 'schemas/input.json', outputSchema: 'schemas/output.json' },
    ],
  }
  await Promise.all(Object.entries({
    'vulcan-skill.json': JSON.stringify(manifest),
    'SKILL.md': '# Echo\n\nReturns the supplied value.',
    'schemas/input.json': JSON.stringify({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }),
    'schemas/output.json': JSON.stringify({ type: 'object', properties: { text: { type: 'string' }, calls: { type: 'integer' } }, required: ['text', 'calls'] }),
    'node/dist/echo.mjs': 'import { writeSync } from "node:fs"; let calls = 0; export function run(args) { writeSync(1, "\\r\\nlauncher log\\n"); return { text: args.text, calls: ++calls }; }',
    'python/echo.py': 'calls = 0\ndef run(args, context):\n    global calls\n    calls += 1\n    print("skill log")\n    return {"text": args["text"], "calls": calls}\n',
  }).map(([file, body]) => writeFile(path.join(source, file), body)))
  return { manifest, source, root, store: new SkillStore(path.join(root, 'home')) }
}

test('management keeps invocation settings and rejects off-protocol or rewritten packages', async t => {
  const { source, manifest, store } = await fixture(t)
  const installed = await store.install(source)
  assert.equal(installed.enabled, true)
  assert.equal(toolMode(installed, manifest.tools[1]), 'implicit')
  assert.equal(toolMode(await store.setMode(manifest.id, 'echo', 'implicit'), manifest.tools[0]), 'implicit')
  assert.equal((await store.setEnabled(manifest.id, false)).enabled, false)
  assert.equal((await store.setEnabled(manifest.id, true)).enabled, true)
  await writeFile(path.join(source, 'SKILL.md'), 'A rewritten version.')
  await assert.rejects(store.install(source), { code: 'version_conflict' })
  await writeFile(path.join(source, 'vulcan-skill.json'), JSON.stringify({ ...manifest, protocol: '>=2.0.0 <3.0.0' }))
  await assert.rejects(store.install(source), { code: 'protocol_unsupported' })
  await store.uninstall(manifest.id)
  assert.deepEqual((await store.state()).skills, {})
})

test('npm registry installs a pinned SHA-512 package from a configured source', async t => {
  const { source, root, store } = await fixture(t)
  const archive = path.join(root, 'sample.tgz')
  await pack({ cwd: root, file: archive, gzip: true }, [path.basename(source)])
  const bytes = await readFile(archive)
  let corrupt = false
  const server = createServer((request, response) => {
    if (request.url === '/%40test%2Fecho/1.0.0') {
      response.end(JSON.stringify({ name: '@test/echo', version: '1.0.0', dist: {
        integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
        tarball: `http://127.0.0.1:${server.address().port}/test-echo.tgz`,
      } }))
    } else {
      response.end(corrupt ? Buffer.concat([bytes, Buffer.from('bad')]) : bytes)
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const registry = `http://127.0.0.1:${server.address().port}`
  await store.setRegistry(registry)
  assert.equal((await store.install('npm:@test/echo@1.0.0')).id, 'test.echo')
  corrupt = true
  await assert.rejects(store.install('npm:@test/echo@1.0.0'), { code: 'integrity_mismatch' })
  await assert.rejects(store.install('npm:@test/echo@latest'), { code: 'invalid_source' })
})

test('workers validate input and reuse the same process for the same workspace', async t => {
  let runtime
  const { source, root, manifest, store } = await fixture(t, async () => runtime?.close())
  await store.install(source)
  // Inject the test runner's interpreter without downloading a release toolchain.
  // 复用测试执行器的解释器，避免测试下载正式工具链。
  runtime = new SkillRuntime(store, { environments: {
    async resolve(pkg) { return { interpreter: process.execPath, root: pkg.root } },
  } })
  await assert.rejects(runtime.call(manifest.id, 'echo', {}, { cwd: root }), { code: 'invalid_arguments' })
  const one = await runtime.call(manifest.id, 'echo', { text: '你好' }, { cwd: root })
  const two = await runtime.call(manifest.id, 'echo', { text: '两次' }, { cwd: root })
  assert.deepEqual(one, { text: '你好', calls: 1 })
  assert.deepEqual(two, { text: '两次', calls: 2 })
  await store.setEnabled(manifest.id, false)
  await assert.rejects(runtime.call(manifest.id, 'echo', { text: 'off' }, { cwd: root }), { code: 'skill_disabled' })
})
