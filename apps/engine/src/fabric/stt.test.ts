import { createServer, type Server } from 'node:http'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Fabric } from '@openinfo/contracts'
import { defaultFabric } from './document.js'
import { invokeStt, type SttAudio } from './invoke.js'

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
