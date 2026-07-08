import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Fabric, LocalRuntime } from '@openinfo/contracts'
import { LocalRuntimeManager, type LocalEndpoint, type RuntimeSpec } from './endpoints/local.js'
import { invokeLlm, invokeStt } from './invoke.js'
import { checkEndpoint } from './health.js'

/** A fake runtime that serves /health, /v1/chat/completions (llm), and /inference (whisper stt). */
const FAKE_SOURCE = `#!/usr/bin/env node
const { createServer } = require('node:http')
const args = process.argv.slice(2)
const port = Number(args[args.indexOf('--port') + 1])
createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    if (req.url === '/health') { res.writeHead(200); res.end('{"status":"ok"}'); return }
    if (req.url === '/v1/chat/completions') {
      const p = JSON.parse(body || '{}')
      const last = (p.messages || []).map((m) => m.content).join(' ')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'FAKE-CHAT: ' + last } }] })); return
    }
    if (req.url === '/inference') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"text":"fake transcript"}'); return }
    res.writeHead(404); res.end()
  })
}).listen(port, '127.0.0.1')
`

const tmp = mkdtempSync(join(tmpdir(), 'oi-local-inv-'))
const fakeBin = join(tmp, 'fake-server')
writeFileSync(fakeBin, FAKE_SOURCE)
chmodSync(fakeBin, 0o755)
const modelFile = join(tmp, 'model.bin')
writeFileSync(modelFile, 'bytes')

const llamaSpec: RuntimeSpec = {
  runtime: 'llama.cpp', binaryNames: ['fake-server'], installHint: 'x',
  args: (m, p) => ['--port', String(p), '-m', m], healthPath: '/health', chat: true,
}
const whisperSpec: RuntimeSpec = {
  runtime: 'whisper.cpp', binaryNames: ['fake-server'], installHint: 'x',
  args: (m, p) => ['--port', String(p), '-m', m], healthPath: '/health', transcribePath: '/inference',
}

const manager = () =>
  new LocalRuntimeManager({
    modelPath: () => modelFile,
    findBinary: () => fakeBin,
    specs: { 'llama.cpp': llamaSpec, 'whisper.cpp': whisperSpec },
    readyTimeoutMs: 5_000,
  })

const llmEndpoint: LocalEndpoint = { kind: 'local', name: 'starter-llm', runtime: 'llama.cpp', model: 'model.bin' }
const sttEndpoint: LocalEndpoint = { kind: 'local', name: 'starter-stt', runtime: 'whisper.cpp', model: 'model.bin' }
const fabricWith = (over: Partial<Fabric['slots']>): Fabric => ({
  slots: { stt: [], tts: [], llm: [], vlm: [], ocr: [], embed: [], ...over },
})

test('invokeLlm routes a local endpoint through its spawned runtime (OpenAI-compat chat)', async () => {
  const mgr = manager()
  try {
    const result = await invokeLlm(fabricWith({ llm: [llmEndpoint] }), [{ role: 'user', content: 'hello there' }], { runtimeManager: mgr })
    assert.match(result.text, /FAKE-CHAT: hello there/)
    assert.equal(result.endpoint, 'starter-llm')
    assert.equal(result.model, 'model.bin')
  } finally {
    mgr.shutdown()
  }
})

test('invokeStt routes a local whisper endpoint to /inference (not /v1/audio/transcriptions)', async () => {
  const mgr = manager()
  try {
    const audio = { base64: Buffer.from('audio-bytes').toString('base64'), contentType: 'audio/wav' }
    const result = await invokeStt(fabricWith({ stt: [sttEndpoint] }), audio, { runtimeManager: mgr })
    assert.equal(result.text, 'fake transcript')
    assert.equal(result.endpoint, 'starter-stt')
  } finally {
    mgr.shutdown()
  }
})

test('without a runtime manager, a local endpoint is skipped gracefully (falls through)', async () => {
  await assert.rejects(
    invokeLlm(fabricWith({ llm: [llmEndpoint] }), [{ role: 'user', content: 'hi' }]),
    /no llm endpoint answered.*not managed here/,
  )
})

test('an unsupported local runtime falls through (does not crash the invoke loop)', async () => {
  const mgr = manager()
  try {
    await assert.rejects(
      invokeLlm(fabricWith({ llm: [{ ...llmEndpoint, runtime: 'mlx' as LocalRuntime }] }), [{ role: 'user', content: 'hi' }], { runtimeManager: mgr }),
      /unsupported local runtime/,
    )
  } finally {
    mgr.shutdown()
  }
})

test('checkEndpoint reports local spawn state honestly (model-missing → ready after spawn)', async () => {
  const noModel = new LocalRuntimeManager({ modelPath: () => join(tmp, 'nope'), findBinary: () => fakeBin, specs: { 'llama.cpp': llamaSpec } })
  const before = await checkEndpoint(llmEndpoint, 1_000, undefined, noModel)
  assert.equal(before.ok, false)
  assert.match(before.error ?? '', /model not downloaded/)

  const mgr = manager()
  try {
    await mgr.ensureRunning(llmEndpoint)
    const after = await checkEndpoint(llmEndpoint, 1_000, undefined, mgr)
    assert.equal(after.ok, true)
  } finally {
    mgr.shutdown()
  }
})

test('checkEndpoint: no manager ⇒ local endpoint is unhealthy but does not throw', async () => {
  const h = await checkEndpoint(llmEndpoint, 1_000)
  assert.equal(h.ok, false)
  assert.match(h.error ?? '', /not managed here/)
})
