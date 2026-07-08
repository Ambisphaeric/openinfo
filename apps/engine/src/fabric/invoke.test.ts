import { createServer, type Server } from 'node:http'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Fabric } from '@openinfo/contracts'
import { defaultFabric } from './document.js'
import { invokeLlm } from './invoke.js'

interface FakeServer {
  server: Server
  url: string
  requests: unknown[]
}

const authHeaders: string[] = []

const startFakeLlm = async (reply: string, status = 200): Promise<FakeServer> => {
  const requests: unknown[] = []
  const server = createServer((req, res) => {
    authHeaders.push(String(req.headers['authorization'] ?? ''))
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply } }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, url: `http://127.0.0.1:${address.port}`, requests }
}

const stop = (s: FakeServer): Promise<void> => new Promise((resolve) => s.server.close(() => resolve()))

test('invokeLlm calls an openai-compat http endpoint and returns provenance', async () => {
  const fake = await startFakeLlm('distilled summary')
  try {
    const fabric: Fabric = { slots: { ...defaultFabric().slots, llm: [{ kind: 'http', name: 'llm.fast', url: fake.url, api: 'openai-compat', model: 'llama-3.2-3b' }] } }
    const result = await invokeLlm(fabric, [{ role: 'user', content: 'summarize' }])
    assert.equal(result.text, 'distilled summary')
    assert.equal(result.endpoint, 'llm.fast')
    assert.equal(result.model, 'llama-3.2-3b')
    assert.equal(result.slot, 'llm')
    assert.deepEqual((fake.requests[0] as { model: string }).model, 'llama-3.2-3b')
  } finally {
    await stop(fake)
  }
})

test('invokeLlm falls through to the next endpoint when the first fails', async () => {
  const good = await startFakeLlm('second answered')
  try {
    const fabric: Fabric = {
      slots: {
        ...defaultFabric().slots,
        llm: [
          { kind: 'http', name: 'dead', url: 'http://127.0.0.1:1', api: 'openai-compat' },
          { kind: 'http', name: 'live', url: good.url, api: 'openai-compat' },
        ],
      },
    }
    const result = await invokeLlm(fabric, [{ role: 'user', content: 'hi' }], { timeoutMs: 500 })
    assert.equal(result.text, 'second answered')
    assert.equal(result.endpoint, 'live')
  } finally {
    await stop(good)
  }
})

test('invokeLlm injects a resolved keyRef as Authorization: Bearer, never the ref/value in logs', async () => {
  const fake = await startFakeLlm('ok')
  authHeaders.length = 0
  try {
    const fabric: Fabric = {
      slots: {
        ...defaultFabric().slots,
        llm: [{ kind: 'http', name: 'authed', url: fake.url, api: 'openai-compat', auth: { keyRef: 'remote-llm-key' } }],
      },
    }
    const result = await invokeLlm(fabric, [{ role: 'user', content: 'hi' }], { resolveKey: (ref) => (ref === 'remote-llm-key' ? 'sk-live-42' : undefined) })
    assert.equal(result.text, 'ok')
    assert.equal(authHeaders[0], 'Bearer sk-live-42')
  } finally {
    await stop(fake)
  }
})

test('an unresolvable keyRef falls through to the next endpoint gracefully (no crash, ref not value in error)', async () => {
  const good = await startFakeLlm('fallback answered')
  authHeaders.length = 0
  try {
    const fabric: Fabric = {
      slots: {
        ...defaultFabric().slots,
        llm: [
          { kind: 'http', name: 'authed', url: 'http://127.0.0.1:1', api: 'openai-compat', auth: { keyRef: 'absent-key' } },
          { kind: 'http', name: 'open', url: good.url, api: 'openai-compat' },
        ],
      },
    }
    // no resolver → the authed endpoint cannot resolve its keyRef, so it is skipped before any fetch
    const result = await invokeLlm(fabric, [{ role: 'user', content: 'hi' }], { resolveKey: () => undefined })
    assert.equal(result.text, 'fallback answered')
    assert.equal(result.endpoint, 'open')
    assert.equal(authHeaders.length, 1) // only the open endpoint was ever contacted
  } finally {
    await stop(good)
  }
})

test('every endpoint unresolvable ⇒ throws with the REF name (never the secret value)', async () => {
  const fabric: Fabric = {
    slots: {
      ...defaultFabric().slots,
      llm: [{ kind: 'http', name: 'authed', url: 'http://127.0.0.1:1', api: 'openai-compat', auth: { keyRef: 'absent-key' } }],
    },
  }
  await assert.rejects(
    () => invokeLlm(fabric, [{ role: 'user', content: 'x' }], { resolveKey: () => undefined }),
    (err: Error) => err.message.includes('absent-key'),
  )
})

test('invokeLlm throws when the slot is empty and skips local/cloud stubs', async () => {
  const fabric: Fabric = {
    slots: {
      ...defaultFabric().slots,
      llm: [
        { kind: 'local', name: 'local-llm', runtime: 'mlx', model: 'qwen3-8b' },
        { kind: 'cloud', name: 'gemini', provider: 'google', auth: 'keychain' },
      ],
    },
  }
  await assert.rejects(() => invokeLlm(fabric, [{ role: 'user', content: 'x' }]), /stubbed|out of scope/)
})
