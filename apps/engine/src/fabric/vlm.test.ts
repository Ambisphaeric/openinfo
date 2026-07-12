import { createServer, type Server } from 'node:http'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Fabric, VlmInvokeParams } from '@openinfo/contracts'
import { defaultFabric } from './document.js'
import { invokeVlm } from './invoke.js'
import { AggregateInvokeError } from './invoke-error.js'

interface FakeVlm {
  server: Server
  url: string
  /** raw request bodies (the JSON chat payload as text) — enough to assert the vision message shape */
  bodies: string[]
}

const vlmAuthHeaders: string[] = []

/** A fake OpenAI-compat vision-chat server that echoes a fixed completion (status configurable). */
const startFakeVlm = async (reply: string, status = 200): Promise<FakeVlm> => {
  const bodies: string[] = []
  const server = createServer((req, res) => {
    vlmAuthHeaders.push(String(req.headers['authorization'] ?? ''))
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'))
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(status === 200 ? JSON.stringify({ choices: [{ message: { content: reply } }] }) : JSON.stringify({ error: reply }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, url: `http://127.0.0.1:${address.port}`, bodies }
}

const stop = (s: FakeVlm): Promise<void> => new Promise((resolve) => s.server.close(() => resolve()))

// A 1x1 PNG's bytes stand in for a frame; the fake server never decodes it.
const params: VlmInvokeParams = {
  image: Buffer.from('PNGDATA').toString('base64'),
  contentType: 'image/png',
  prompt: 'summarize this screen',
}

test('invokeVlm POSTs the OpenAI-compat vision-chat shape (prompt + image data URI) and returns text + provenance', async () => {
  const fake = await startFakeVlm('a login screen with an error toast')
  try {
    const fabric: Fabric = {
      slots: { ...defaultFabric().slots, vlm: [{ kind: 'http', name: 'lm-studio', url: fake.url, api: 'openai-compat', model: 'qwen2.5-vl-7b' }] },
    }
    const result = await invokeVlm(fabric, params)
    assert.equal(result.text, 'a login screen with an error toast')
    assert.equal(result.endpoint, 'lm-studio')
    assert.equal(result.model, 'qwen2.5-vl-7b')
    assert.equal(result.slot, 'vlm')
    assert.equal(result.blocks, undefined) // a vlm produces prose, no region blocks
    const body = JSON.parse(fake.bodies[0]!) as {
      model: string
      messages: { role: string; content: { type: string; text?: string; image_url?: { url: string } }[] }[]
    }
    assert.equal(body.model, 'qwen2.5-vl-7b')
    assert.equal(body.messages[0]!.role, 'user')
    const [textPart, imagePart] = body.messages[0]!.content
    assert.deepEqual(textPart, { type: 'text', text: 'summarize this screen' })
    assert.equal(imagePart!.type, 'image_url')
    assert.equal(imagePart!.image_url!.url, `data:image/png;base64,${params.image}`)
  } finally {
    await stop(fake)
  }
})

test('invokeVlm returns empty prose for a blank frame (not an error)', async () => {
  const fake = await startFakeVlm('')
  try {
    const fabric: Fabric = {
      slots: { ...defaultFabric().slots, vlm: [{ kind: 'http', name: 'vlm-box', url: fake.url, api: 'openai-compat', model: 'moondream' }] },
    }
    const result = await invokeVlm(fabric, params)
    assert.equal(result.text, '')
    assert.equal(result.endpoint, 'vlm-box')
  } finally {
    await stop(fake)
  }
})

test('invokeVlm falls through to the next endpoint when the first is unreachable', async () => {
  const good = await startFakeVlm('second answered')
  try {
    const fabric: Fabric = {
      slots: {
        ...defaultFabric().slots,
        vlm: [
          { kind: 'http', name: 'dead', url: 'http://127.0.0.1:1', api: 'openai-compat', model: 'x' },
          { kind: 'http', name: 'live', url: good.url, api: 'openai-compat', model: 'qwen2.5-vl-7b' },
        ],
      },
    }
    const result = await invokeVlm(fabric, params, {})
    assert.equal(result.text, 'second answered')
    assert.equal(result.endpoint, 'live')
  } finally {
    await stop(good)
  }
})

test('invokeVlm sends raw frames only to loopback, skipping private-LAN and public HTTP endpoints before fetch', async () => {
  const local = await startFakeVlm('described locally')
  const originalFetch = globalThis.fetch
  const attempted: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    attempted.push(url)
    if (!url.startsWith(local.url)) throw new Error(`non-loopback fetch attempted: ${url}`)
    return originalFetch(input, init)
  }
  try {
    const fabric: Fabric = {
      slots: {
        ...defaultFabric().slots,
        vlm: [
          { kind: 'http', name: 'lan-vlm', url: 'http://10.0.0.20:8000', api: 'openai-compat' },
          { kind: 'http', name: 'public-vlm', url: 'https://vlm.example.test', api: 'openai-compat' },
          { kind: 'http', name: 'loopback-vlm', url: local.url, api: 'openai-compat' },
        ],
      },
    }
    const result = await invokeVlm(fabric, params)
    assert.equal(result.endpoint, 'loopback-vlm')
    assert.equal(result.text, 'described locally')
    assert.deepEqual(attempted, [`${local.url}/v1/chat/completions`])
  } finally {
    globalThis.fetch = originalFetch
    await stop(local)
  }
})

test('invokeVlm sends raw frames to a LAN endpoint the user explicitly flagged trustRawFrames', async () => {
  const lanTarget = await startFakeVlm('described on the trusted box')
  const port = new URL(lanTarget.url).port
  const documentedUrl = `http://10.0.0.20:${port}`
  const originalFetch = globalThis.fetch
  const attempted: string[] = []
  // Keep the endpoint document honestly private-LAN for policy classification, while steering this test's
  // transport to its loopback fake server (the invoke.test.ts documentedUrl idiom).
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    attempted.push(url)
    return originalFetch(url.replace(documentedUrl, lanTarget.url), init)
  }
  try {
    const fabric: Fabric = {
      slots: {
        ...defaultFabric().slots,
        vlm: [{ kind: 'http', name: 'trusted-lan-vlm', url: documentedUrl, api: 'openai-compat', trustRawFrames: true }],
      },
    }
    const result = await invokeVlm(fabric, params)
    assert.equal(result.endpoint, 'trusted-lan-vlm')
    assert.equal(result.text, 'described on the trusted box')
    assert.deepEqual(attempted, [`${documentedUrl}/v1/chat/completions`])
  } finally {
    globalThis.fetch = originalFetch
    await stop(lanTarget)
  }
})

test('invokeVlm skips an untrusted LAN endpoint and a flagged PUBLIC endpoint before fetch, naming the real reasons', async () => {
  const originalFetch = globalThis.fetch
  const attempted: string[] = []
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    attempted.push(url)
    throw new Error(`no fetch may happen: ${url}`)
  }
  try {
    const fabric: Fabric = {
      slots: {
        ...defaultFabric().slots,
        vlm: [
          { kind: 'http', name: 'lan-vlm', url: 'http://10.0.0.20:8000', api: 'openai-compat' }, // no flag
          { kind: 'http', name: 'public-vlm', url: 'https://vlm.example.test', api: 'openai-compat', trustRawFrames: true }, // flag cannot cross the LAN cap
        ],
      },
    }
    await assert.rejects(
      () => invokeVlm(fabric, params),
      (error: unknown) => {
        assert.ok(error instanceof AggregateInvokeError)
        assert.equal(error.failures.length, 2)
        assert.ok(error.failures.every((f) => f.class === 'egress-denied'))
        assert.match(error.message, /lan-vlm: raw screen frames are loopback-only — set trustRawFrames on this endpoint to allow it/)
        assert.match(error.message, /public-vlm: raw screen frames require a local-network host — public endpoint skipped despite trustRawFrames/)
        return true
      },
    )
    assert.deepEqual(attempted, []) // both skips happened BEFORE any fetch
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('invokeVlm injects a resolved keyRef as Authorization: Bearer', async () => {
  const fake = await startFakeVlm('authed answer')
  vlmAuthHeaders.length = 0
  try {
    const fabric: Fabric = {
      slots: { ...defaultFabric().slots, vlm: [{ kind: 'http', name: 'remote-vlm', url: fake.url, api: 'openai-compat', auth: { keyRef: 'remote-vlm-key' } }] },
    }
    const result = await invokeVlm(fabric, params, { resolveKey: (ref) => (ref === 'remote-vlm-key' ? 'sk-vlm-1' : undefined) })
    assert.equal(result.text, 'authed answer')
    assert.equal(vlmAuthHeaders[0], 'Bearer sk-vlm-1')
  } finally {
    await stop(fake)
  }
})

test('invokeVlm with an unresolvable keyRef falls through gracefully (never contacts the authed endpoint)', async () => {
  const good = await startFakeVlm('fallback answer')
  vlmAuthHeaders.length = 0
  try {
    const fabric: Fabric = {
      slots: {
        ...defaultFabric().slots,
        vlm: [
          { kind: 'http', name: 'authed', url: 'http://127.0.0.1:1', api: 'openai-compat', auth: { keyRef: 'absent' } },
          { kind: 'http', name: 'open', url: good.url, api: 'openai-compat', model: 'qwen2.5-vl-7b' },
        ],
      },
    }
    const result = await invokeVlm(fabric, params, { resolveKey: () => undefined })
    assert.equal(result.text, 'fallback answer')
    assert.equal(vlmAuthHeaders.length, 1) // the authed endpoint was skipped before any fetch
  } finally {
    await stop(good)
  }
})

test('invokeVlm classifies a non-string content payload as bad-response', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: {} }] })) // no content field
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const url = `http://127.0.0.1:${address.port}`
  try {
    const fabric: Fabric = {
      slots: { ...defaultFabric().slots, vlm: [{ kind: 'http', name: 'weird', url, api: 'openai-compat', model: 'x' }] },
    }
    await assert.rejects(() => invokeVlm(fabric, params), /no vlm endpoint answered.*bad-response|bad-response/)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('invokeVlm surfaces a timeout classification when the endpoint hangs', async () => {
  const slow = createServer(() => {
    /* never responds */
  })
  await new Promise<void>((resolve) => slow.listen(0, resolve))
  const address = slow.address()
  assert.ok(address && typeof address === 'object')
  const url = `http://127.0.0.1:${address.port}`
  try {
    const fabric: Fabric = {
      slots: { ...defaultFabric().slots, vlm: [{ kind: 'http', name: 'hang', url, api: 'openai-compat', model: 'x' }] },
    }
    await assert.rejects(() => invokeVlm(fabric, { ...params, timeoutMs: 200 }), /timeout/)
  } finally {
    await new Promise<void>((resolve) => slow.close(() => resolve()))
  }
})

test('invokeVlm throws AggregateInvokeError(slot: vlm) when the slot is empty and skips cloud/unsupported-local', async () => {
  const fabric: Fabric = {
    slots: {
      ...defaultFabric().slots,
      vlm: [
        { kind: 'local', name: 'paddle-vlm', runtime: 'mlx', model: 'qwen2.5-vl' }, // unmanaged in v0 → falls through
        { kind: 'cloud', name: 'gemini', provider: 'google', auth: 'keychain' },
      ],
    },
  }
  await assert.rejects(
    () => invokeVlm(fabric, params),
    (error: unknown) => {
      assert.ok(error instanceof AggregateInvokeError)
      assert.equal(error.slot, 'vlm')
      return true
    },
  )
})
