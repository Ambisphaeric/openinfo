import { createServer, type Server } from 'node:http'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Fabric } from '@openinfo/contracts'
import { defaultFabric } from './document.js'
import { invokeStt, type SttAudio } from './invoke.js'
import { LocalRuntimeManager, type LocalEndpoint, type RuntimeSpec } from './endpoints/local.js'
import { AggregateInvokeError } from './invoke-error.js'

interface FakeStt {
  server: Server
  url: string
  /** raw request bodies (the multipart payload as text) — enough to assert model/file were sent */
  bodies: string[]
}

const sttAuthHeaders: string[] = []

const startFakeStt = async (reply: string, status = 200): Promise<FakeStt> => {
  const bodies: string[] = []
  const server = createServer((req, res) => {
    sttAuthHeaders.push(String(req.headers['authorization'] ?? ''))
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'))
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ text: reply }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, url: `http://127.0.0.1:${address.port}`, bodies }
}

const stop = (s: FakeStt): Promise<void> => new Promise((resolve) => s.server.close(() => resolve()))

// "hello" as a base64 payload stands in for audio bytes; the fake server never decodes it.
const audio: SttAudio = { base64: Buffer.from('hello').toString('base64'), contentType: 'audio/wav' }

test('invokeStt POSTs the multipart transcription shape and returns text + provenance', async () => {
  const fake = await startFakeStt('shipped Thursday')
  try {
    const fabric: Fabric = {
      slots: { ...defaultFabric().slots, stt: [{ kind: 'http', name: 'parakeet-box', url: fake.url, api: 'openai-compat', model: 'parakeet-110m' }] },
    }
    const result = await invokeStt(fabric, audio)
    assert.equal(result.text, 'shipped Thursday')
    assert.equal(result.endpoint, 'parakeet-box')
    assert.equal(result.model, 'parakeet-110m')
    assert.equal(result.slot, 'stt')
    // the multipart body carried the model field, a filename sniffable from audio/wav, and the file part
    assert.match(fake.bodies[0]!, /name="model"/)
    assert.match(fake.bodies[0]!, /parakeet-110m/)
    assert.match(fake.bodies[0]!, /name="file"; filename="audio\.wav"/)
  } finally {
    await stop(fake)
  }
})

test('invokeStt returns an empty transcript for silence (not an error)', async () => {
  const fake = await startFakeStt('')
  try {
    const fabric: Fabric = {
      slots: { ...defaultFabric().slots, stt: [{ kind: 'http', name: 'stt-box', url: fake.url, api: 'openai-compat', model: 'whisper' }] },
    }
    const result = await invokeStt(fabric, audio)
    assert.equal(result.text, '')
    assert.equal(result.endpoint, 'stt-box')
  } finally {
    await stop(fake)
  }
})

test('invokeStt falls through to the next endpoint when the first fails', async () => {
  const good = await startFakeStt('second answered')
  try {
    const fabric: Fabric = {
      slots: {
        ...defaultFabric().slots,
        stt: [
          { kind: 'http', name: 'dead', url: 'http://127.0.0.1:1', api: 'openai-compat', model: 'x' },
          { kind: 'http', name: 'live', url: good.url, api: 'openai-compat', model: 'whisper' },
        ],
      },
    }
    const result = await invokeStt(fabric, audio, { timeoutMs: 500 })
    assert.equal(result.text, 'second answered')
    assert.equal(result.endpoint, 'live')
  } finally {
    await stop(good)
  }
})

test('invokeStt refuses a 308 redirect before forwarding the audio body', async () => {
  const sink = await startFakeStt('redirected transcript')
  const redirect = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(308, { location: `${sink.url}${req.url ?? '/v1/audio/transcriptions'}` })
      res.end()
    })
  })
  await new Promise<void>((resolve) => redirect.listen(0, resolve))
  const address = redirect.address()
  assert.ok(address && typeof address === 'object')
  const redirectingUrl = `http://127.0.0.1:${address.port}`
  try {
    const fabric: Fabric = {
      slots: {
        ...defaultFabric().slots,
        stt: [{ kind: 'http', name: 'redirecting-stt', url: redirectingUrl, api: 'openai-compat' }],
      },
    }
    await assert.rejects(
      () => invokeStt(fabric, { base64: Buffer.from('AUDIO_MUST_NOT_REACH_REDIRECT_SINK').toString('base64'), contentType: 'audio/wav' }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateInvokeError)
        assert.equal(error.failures[0]?.class, 'bad-response')
        return true
      },
    )
    assert.equal(sink.bodies.length, 0, 'redirect target must never receive the multipart audio body')
  } finally {
    await new Promise<void>((resolve) => redirect.close(() => resolve()))
    await stop(sink)
  }
})

test('invokeStt injects a resolved keyRef as Authorization: Bearer', async () => {
  const fake = await startFakeStt('authed transcript')
  sttAuthHeaders.length = 0
  try {
    const fabric: Fabric = {
      slots: { ...defaultFabric().slots, stt: [{ kind: 'http', name: 'remote-stt', url: fake.url, api: 'openai-compat', auth: { keyRef: 'remote-stt-key' } }] },
    }
    const result = await invokeStt(fabric, audio, { resolveKey: (ref) => (ref === 'remote-stt-key' ? 'sk-stt-9' : undefined) })
    assert.equal(result.text, 'authed transcript')
    assert.equal(sttAuthHeaders[0], 'Bearer sk-stt-9')
  } finally {
    await stop(fake)
  }
})

test('invokeStt with an unresolvable keyRef falls through gracefully (never contacts the authed endpoint)', async () => {
  const good = await startFakeStt('fallback transcript')
  sttAuthHeaders.length = 0
  try {
    const fabric: Fabric = {
      slots: {
        ...defaultFabric().slots,
        stt: [
          { kind: 'http', name: 'authed', url: 'http://127.0.0.1:1', api: 'openai-compat', auth: { keyRef: 'absent' } },
          { kind: 'http', name: 'open', url: good.url, api: 'openai-compat', model: 'whisper' },
        ],
      },
    }
    const result = await invokeStt(fabric, audio, { resolveKey: () => undefined })
    assert.equal(result.text, 'fallback transcript')
    assert.equal(sttAuthHeaders.length, 1)
  } finally {
    await stop(good)
  }
})

test('invokeStt returns the canonical transcript (language + duration + segments) from an omlx-shaped body', async () => {
  // The verbose_json body omlx 0.4.5 returns live; the openai adapter normalizes it to canonical form.
  const bodies: string[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ text: ' shipped Thursday', language: 'en', duration: 1.5, segments: [{ start: 0, end: 1.5, text: ' shipped Thursday' }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  assert.ok(addr && typeof addr === 'object')
  try {
    const fabric: Fabric = {
      slots: { ...defaultFabric().slots, stt: [{ kind: 'http', name: 'omlx', url: `http://127.0.0.1:${addr.port}`, api: 'openai-compat', model: 'whisper' }] },
    }
    const result = await invokeStt(fabric, audio)
    assert.equal(result.text, ' shipped Thursday')
    assert.equal(result.language, 'en')
    assert.equal(result.durationSec, 1.5)
    assert.deepEqual(result.segments, [{ text: ' shipped Thursday', startSec: 0, endSec: 1.5 }])
    assert.match(bodies[0]!, /name="response_format"[\s\S]*json/)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

// The ONE broken pipeline P4-T9 fixes: a `local` mlx (omlx) STT endpoint. Before the adapter seam it
// hard-failed ("local runtime has no transcription path") and, even routed, never sent the `model` form
// field omlx REQUIRES. This proves it now adopts the server, sends the served model id + a bearer, hits
// /v1/audio/transcriptions (NOT whisper's /inference), and normalizes the omlx body.
test('invokeStt routes a local mlx endpoint to /v1/audio/transcriptions with the served model + bearer (parakeet-shaped)', async () => {
  const seen: { url?: string; auth?: string; body?: string } = {}
  const server = createServer((req, res) => {
    if (req.headers['authorization'] !== 'Bearer rig-secret') { res.writeHead(401); res.end('need key'); return }
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      seen.url = req.url ?? ''
      seen.auth = String(req.headers['authorization'])
      seen.body = Buffer.concat(chunks).toString('utf8')
      if (req.url === '/health') { res.writeHead(200); res.end('ok'); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ text: 'parakeet transcript', language: 'en' }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  assert.ok(addr && typeof addr === 'object')
  const mlxSpec: RuntimeSpec = {
    runtime: 'mlx', binaryNames: ['omlx'], installHint: 'start omlx', args: () => [],
    healthPath: '/health', chat: true, multiModel: true, defaultPort: addr.port, adoptOnly: true,
  }
  const mgr = new LocalRuntimeManager({ modelPath: () => undefined, findBinary: () => undefined, specs: { mlx: mlxSpec } })
  const endpoint: LocalEndpoint = { kind: 'local', name: 'omlx-stt', runtime: 'mlx', model: 'mlx-community_parakeet-tdt_ctc-110m', auth: { keyRef: 'api_d' } }
  try {
    const fabric: Fabric = { slots: { ...defaultFabric().slots, stt: [endpoint] } }
    const result = await invokeStt(fabric, audio, { runtimeManager: mgr, resolveKey: (r) => (r === 'api_d' ? 'rig-secret' : undefined) })
    assert.equal(result.text, 'parakeet transcript')
    assert.equal(result.language, 'en')
    assert.equal(result.endpoint, 'omlx-stt')
    assert.equal(result.model, 'mlx-community_parakeet-tdt_ctc-110m')
    assert.equal(seen.url, '/v1/audio/transcriptions')
    assert.equal(seen.auth, 'Bearer rig-secret')
    assert.match(seen.body!, /name="model"[\s\S]*mlx-community_parakeet-tdt_ctc-110m/)
  } finally {
    mgr.shutdown()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('invokeStt throws when the slot is empty and skips local/cloud stubs', async () => {
  const fabric: Fabric = {
    slots: {
      ...defaultFabric().slots,
      stt: [
        { kind: 'local', name: 'parakeet-local', runtime: 'mlx', model: 'parakeet-110m' },
        { kind: 'cloud', name: 'gemini', provider: 'google', auth: 'keychain' },
      ],
    },
  }
  await assert.rejects(() => invokeStt(fabric, audio), /stubbed|out of scope/)
})
