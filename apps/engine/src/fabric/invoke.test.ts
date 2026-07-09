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

test('callHttp includes chat_template_kwargs + response_format in the body when the endpoint sets them', async () => {
  const fake = await startFakeLlm('ok')
  try {
    const fabric: Fabric = {
      slots: {
        ...defaultFabric().slots,
        llm: [{
          kind: 'http', name: 'qwen', url: fake.url, api: 'openai-compat', model: 'qwen3.5-9b',
          chatTemplateKwargs: { enable_thinking: false },
          responseFormat: { type: 'json_object' },
        }],
      },
    }
    await invokeLlm(fabric, [{ role: 'user', content: 'distill this' }])
    const body = fake.requests[0] as { chat_template_kwargs?: unknown; response_format?: unknown }
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false })
    assert.deepEqual(body.response_format, { type: 'json_object' })
  } finally {
    await stop(fake)
  }
})

test('callHttp OMITS both extras when the endpoint sets neither (byte-for-byte the legacy body)', async () => {
  const fake = await startFakeLlm('ok')
  try {
    const fabric: Fabric = {
      slots: { ...defaultFabric().slots, llm: [{ kind: 'http', name: 'plain', url: fake.url, api: 'openai-compat', model: 'llama' }] },
    }
    await invokeLlm(fabric, [{ role: 'user', content: 'hi' }])
    const body = fake.requests[0] as Record<string, unknown>
    assert.equal('chat_template_kwargs' in body, false)
    assert.equal('response_format' in body, false)
  } finally {
    await stop(fake)
  }
})

test('the qwen3.5-9b thinking-burn is addressable via chatTemplateKwargs {enable_thinking:false}', async () => {
  // A fake that reproduces the rig: at its default it burns the whole budget reasoning (empty content,
  // finish_reason length ⇒ classified reasoning-exhausted); told enable_thinking:false it answers in text.
  const requests: unknown[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { chat_template_kwargs?: { enable_thinking?: boolean } }
      requests.push(body)
      res.writeHead(200, { 'content-type': 'application/json' })
      if (body.chat_template_kwargs?.enable_thinking === false) {
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"summary":"done"}' } }] }))
      } else {
        res.end(JSON.stringify({ choices: [{ message: { content: '', reasoning_content: 'thinking…' }, finish_reason: 'length' }] }))
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const url = `http://127.0.0.1:${address.port}`
  try {
    const burns: Fabric = { slots: { ...defaultFabric().slots, llm: [{ kind: 'http', name: 'qwen', url, api: 'openai-compat', model: 'qwen3.5-9b' }] } }
    // Default: the distill budget goes to reasoning, so the completion fails (the CONFIRMED rig failure).
    await assert.rejects(() => invokeLlm(burns, [{ role: 'user', content: 'distill' }], { maxTokens: 700 }), /reasoning|no llm endpoint answered/)
    // With enable_thinking:false the same model returns real content — the burn is addressed per-endpoint.
    const fixed: Fabric = { slots: { ...defaultFabric().slots, llm: [{ kind: 'http', name: 'qwen', url, api: 'openai-compat', model: 'qwen3.5-9b', chatTemplateKwargs: { enable_thinking: false } }] } }
    const result = await invokeLlm(fixed, [{ role: 'user', content: 'distill' }], { maxTokens: 700 })
    assert.equal(result.text, '{"summary":"done"}')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
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
