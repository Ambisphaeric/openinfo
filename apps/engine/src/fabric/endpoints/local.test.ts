import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
})

test('mlx/omlx is a managed runtime: adopt-only, multi-model, fixed port, openai-compat chat', () => {
  const mlx = RUNTIME_SPECS['mlx']
  assert.ok(mlx, 'mlx now resolves (no longer unsupported)')
  assert.equal(mlx.binaryNames[0], 'omlx')
  assert.equal(mlx.adoptOnly, true) // externally managed by oMLX.app + the LaunchAgent — never spawned
  assert.equal(mlx.multiModel, true) // one server backs llm/stt/tts from a model dir
  assert.equal(mlx.defaultPort, 8000)
  assert.equal(mlx.chat, true)
  assert.match(mlx.installHint, /oMLX\.app|omlx start/)
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

// --- mlx/omlx: an ADOPT-ONLY runtime (managed outside the engine) is discovered-and-adopted, not spawned ---

/** A stand-in for an already-running omlx on a fixed port: /health 200, openai-compat chat. */
const startOmlxFake = async (): Promise<{ server: Server; port: number; url: string }> => {
  const server = createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200); res.end('ok'); return }
    if (req.url === '/v1/chat/completions') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'OMLX-OK' } }] })); return }
    res.writeHead(404); res.end('nope')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  assert.ok(addr && typeof addr === 'object')
  return { server, port: addr.port, url: `http://127.0.0.1:${addr.port}` }
}
const closeServer = (s: Server): Promise<void> => new Promise((resolve) => s.close(() => resolve()))

const mlxSpec = (port: number): RuntimeSpec => ({
  runtime: 'mlx', binaryNames: ['omlx'], installHint: 'start it via oMLX.app',
  args: () => [], healthPath: '/health', chat: true, multiModel: true, defaultPort: port, adoptOnly: true,
})
const mlxEp = (over: Partial<LocalEndpoint> = {}): LocalEndpoint => ({ kind: 'local', name: 'omlx-llm', runtime: 'mlx', model: 'LFM2.5-8B-A1B-MLX-8bit', ...over })
// adopt needs neither a binary on PATH nor a model file on disk — the server is already up, externally.
const adoptManager = (port: number) => new LocalRuntimeManager({ modelPath: () => undefined, findBinary: () => undefined, specs: { mlx: mlxSpec(port) } })

test('mlx adopt: an omlx already on its port is ADOPTED (no spawn, no binary/model needed); shutdown leaves it running', async () => {
  const fake = await startOmlxFake()
  const mgr = adoptManager(fake.port)
  try {
    assert.equal(mgr.status(mlxEp()), 'stopped') // adopt-only, not adopted yet (adopts on demand)
    const { url, spec } = await mgr.ensureRunning(mlxEp())
    assert.equal(url, fake.url)
    assert.equal(spec.chat, true)
    assert.equal(mgr.status(mlxEp()), 'ready') // adopted → ready
    const answer = await fetch(`${url}/v1/chat/completions`, { method: 'POST', body: '{}' })
    assert.equal(answer.status, 200)
    mgr.shutdown()
    // the engine never owned the process, so shutdown must NOT kill it — the external server still answers
    assert.equal((await fetch(`${fake.url}/health`)).status, 200)
  } finally {
    await closeServer(fake.server)
  }
})

test('mlx adopt: a multi-model server backs every slot from ONE adopted process (keyed by port, not model)', async () => {
  const fake = await startOmlxFake()
  const mgr = adoptManager(fake.port)
  try {
    const llm = await mgr.ensureRunning(mlxEp({ name: 'omlx-llm', model: 'LFM2.5-8B-A1B-MLX-8bit' }))
    const stt = await mgr.ensureRunning(mlxEp({ name: 'omlx-stt', model: 'mlx-community_parakeet-tdt_ctc-110m' }))
    assert.equal(llm.url, stt.url) // same adopted server — not adopted once per model
  } finally {
    mgr.shutdown()
    await closeServer(fake.server)
  }
})

test('mlx adopt: nothing listening on the port fails honestly (start it via the app), never spawns/collides', async () => {
  const fake = await startOmlxFake()
  const port = fake.port
  await closeServer(fake.server) // free the port, then point the adopt at it → nothing there
  const mgr = adoptManager(port)
  await assert.rejects(mgr.ensureRunning(mlxEp()), new RegExp(`not running on :${port}`))
  assert.equal(mgr.status(mlxEp()), 'stopped') // still just "adopts on demand", never crashed/spawned
})
