import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LocalRuntime } from '@openinfo/contracts'
import { LocalRuntimeManager, findRuntimeBinary, RUNTIME_SPECS, type LocalEndpoint, type RuntimeSpec } from './local.js'

/**
 * A FAKE runtime binary: a standalone node script that serves the OpenAI-compat surface (/health,
 * /v1/chat/completions, /inference) on the --port it is given. Behaviour is env-controlled so one
 * script exercises ready-delay, crash-on-start, and crash-after-ready. Written to a temp dir + chmod
 * +x so the manager spawns it exactly like a real llama-server (real spawn/ready/kill/crash machinery).
 */
const FAKE_SOURCE = `#!/usr/bin/env node
const { createServer } = require('node:http')
const args = process.argv.slice(2)
const port = Number(args[args.indexOf('--port') + 1])
const crashOnStart = process.env.FAKE_CRASH_ON_START === '1'
if (crashOnStart) { process.exit(3) }
const readyDelay = Number(process.env.FAKE_READY_DELAY_MS || '0')
const startedAt = Date.now()
const crashAfter = Number(process.env.FAKE_CRASH_AFTER_MS || '0')
if (crashAfter > 0) setTimeout(() => process.exit(4), crashAfter)
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    if (req.url === '/health') {
      if (Date.now() - startedAt < readyDelay) { res.writeHead(503); res.end('loading'); return }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'ok' })); return
    }
    if (req.url === '/v1/chat/completions') {
      const parsed = JSON.parse(body || '{}')
      const last = (parsed.messages || []).map((m) => m.content).join(' | ')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'FAKE-CHAT: ' + last } }] }))
      return
    }
    if (req.url === '/inference') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ text: 'fake transcript' }))
      return
    }
    res.writeHead(404); res.end('nope')
  })
})
server.listen(port, '127.0.0.1')
`

const tmp = mkdtempSync(join(tmpdir(), 'oi-local-'))
const fakeBin = join(tmp, 'fake-server')
writeFileSync(fakeBin, FAKE_SOURCE)
chmodSync(fakeBin, 0o755)
const modelFile = join(tmp, 'model.gguf')
writeFileSync(modelFile, 'GGUF-fake-bytes')

const fakeSpec: RuntimeSpec = {
  runtime: 'llama.cpp',
  binaryNames: ['fake-server'],
  installHint: 'install the fake',
  args: (model, port) => ['--host', '127.0.0.1', '--port', String(port), '-m', model],
  healthPath: '/health',
  chat: true,
}

const ep = (over: Partial<LocalEndpoint> = {}): LocalEndpoint => ({
  kind: 'local', name: 'fake-llm', runtime: 'llama.cpp', model: 'fake-model', ...over,
})

const managerWith = (over: Partial<ConstructorParameters<typeof LocalRuntimeManager>[0]> = {}) =>
  new LocalRuntimeManager({
    modelPath: () => modelFile,
    findBinary: () => fakeBin,
    specs: { 'llama.cpp': fakeSpec },
    readyTimeoutMs: 5_000,
    ...over,
  })

test('findRuntimeBinary: found on PATH, missing when absent', () => {
  const prevPath = process.env['PATH']
  process.env['PATH'] = tmp
  try {
    assert.equal(findRuntimeBinary(fakeSpec), fakeBin)
    assert.equal(findRuntimeBinary({ ...fakeSpec, binaryNames: ['definitely-not-a-real-binary-xyz'] }), undefined)
  } finally {
    process.env['PATH'] = prevPath
  }
})

test('the real specs name the v0 runtimes with honest install hints', () => {
  assert.equal(RUNTIME_SPECS['llama.cpp']?.installHint, 'brew install llama.cpp')
  assert.equal(RUNTIME_SPECS['whisper.cpp']?.installHint, 'brew install whisper-cpp')
  assert.equal(RUNTIME_SPECS['whisper.cpp']?.transcribePath, '/inference')
  assert.equal(RUNTIME_SPECS['mlx' as LocalRuntime], undefined) // future runtime, unsupported in v0
})

test('ensureRunning: spawn → ready → localhost url that answers /health + chat; idempotent; shutdown kills', async () => {
  const mgr = managerWith()
  assert.equal(mgr.status(ep()), 'stopped')
  const { url, spec } = await mgr.ensureRunning(ep())
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.equal(spec.chat, true)
  assert.equal(mgr.status(ep()), 'ready')
  const health = await fetch(`${url}/health`)
  assert.equal(health.status, 200)
  // idempotent: a second call returns the same url without a second spawn
  const again = await mgr.ensureRunning(ep())
  assert.equal(again.url, url)
  mgr.shutdown()
  assert.equal(mgr.status(ep()), 'stopped')
})

test('ensureRunning: concurrent calls share ONE spawn', async () => {
  const mgr = managerWith()
  const [a, b] = await Promise.all([mgr.ensureRunning(ep()), mgr.ensureRunning(ep())])
  assert.equal(a.url, b.url)
  mgr.shutdown()
})

test('binary-missing and model-missing are reported honestly (no throw from status)', () => {
  const noBin = managerWith({ findBinary: () => undefined })
  assert.equal(noBin.status(ep()), 'binary-missing')
  const noModel = managerWith({ modelPath: () => join(tmp, 'nope.gguf') })
  assert.equal(noModel.status(ep()), 'model-missing')
  assert.equal(managerWith().status(ep({ runtime: 'mlx' })), 'unsupported')
})

test('ensureRunning throws (never crashes engine) when the binary is missing', async () => {
  const mgr = managerWith({ findBinary: () => undefined })
  await assert.rejects(mgr.ensureRunning(ep()), /binary not found — install the fake/)
})

test('crash-on-start is bounded: after maxRestarts the runtime reports crashed and stops respawning', async () => {
  process.env['FAKE_CRASH_ON_START'] = '1'
  const mgr = managerWith({ maxRestarts: 2, readyTimeoutMs: 2_000 })
  try {
    await assert.rejects(mgr.ensureRunning(ep()))
    await assert.rejects(mgr.ensureRunning(ep()))
    assert.equal(mgr.status(ep()), 'crashed')
    // once crashed the budget is spent — no further spawn attempt
    await assert.rejects(mgr.ensureRunning(ep()), /not restarting/)
  } finally {
    delete process.env['FAKE_CRASH_ON_START']
    mgr.shutdown()
  }
})

test('readiness wait times out cleanly when the server never answers /health', async () => {
  process.env['FAKE_READY_DELAY_MS'] = '100000'
  const mgr = managerWith({ readyTimeoutMs: 600 })
  try {
    await assert.rejects(mgr.ensureRunning(ep()), /did not become ready/)
  } finally {
    delete process.env['FAKE_READY_DELAY_MS']
    mgr.shutdown()
  }
})
