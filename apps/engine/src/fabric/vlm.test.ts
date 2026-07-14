import { createServer, type Server } from 'node:http'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Fabric, VlmInvokeParams } from '@openinfo/contracts'
import { defaultFabric } from './document.js'
import { resolveEgress } from './egress.js'
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

const stop = (s: { server: Server }): Promise<void> => new Promise((resolve) => s.server.close(() => resolve()))

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

test('invokeVlm never retains a non-OK response body that echoes the submitted raw frame', async () => {
  const rawFrameSentinel = Buffer.from('RAW_FRAME_ECHO_SENTINEL_VLM_175').toString('base64')
  let receivedBody = ''
  const echo = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      receivedBody = Buffer.concat(chunks).toString('utf8')
      res.writeHead(422, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: `server echoed request: ${receivedBody}` }))
    })
  })
  await new Promise<void>((resolve) => echo.listen(0, resolve))
  const address = echo.address()
  assert.ok(address && typeof address === 'object')
  const url = `http://127.0.0.1:${address.port}`
  try {
    const fabric: Fabric = {
      slots: {
        ...defaultFabric().slots,
        vlm: [{ kind: 'http', name: 'echoing-vlm', url, api: 'openai-compat', model: 'qwen2.5-vl-7b' }],
      },
    }
    await assert.rejects(
      () => invokeVlm(fabric, { ...params, image: rawFrameSentinel }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateInvokeError)
        assert.equal(error.slot, 'vlm')
        assert.equal(error.failures[0]?.class, 'bad-response')
        assert.equal(error.failures[0]?.endpoint, 'echoing-vlm')
        assert.equal(error.failures[0]?.model, 'qwen2.5-vl-7b')
        assert.equal(error.failures[0]?.serverMessage, 'HTTP 422')
        assert.match(error.failures[0]?.hint ?? '', /server responded in an unexpected way/)
        assert.equal(error.message.includes(rawFrameSentinel), false, 'aggregate message must not copy frame bytes')
        assert.equal(JSON.stringify(error.failures).includes(rawFrameSentinel), false, 'classified failures must not copy frame bytes')
        return true
      },
    )
    assert.equal(receivedBody.includes(rawFrameSentinel), true, 'fake endpoint really received and echoed the sentinel')
  } finally {
    await stop({ server: echo })
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

test('invokeVlm refuses a 308 redirect before forwarding raw frame bytes', async () => {
  const sink = await startFakeVlm('redirected VLM answer')
  const redirect = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(308, { location: `${sink.url}${req.url ?? '/v1/chat/completions'}` })
      res.end()
    })
  })
  await new Promise<void>((resolve) => redirect.listen(0, resolve))
  const address = redirect.address()
  assert.ok(address && typeof address === 'object')
  const redirectingUrl = `http://127.0.0.1:${address.port}`
  const rawFrameSentinel = Buffer.from('VLM_FRAME_MUST_NOT_REACH_REDIRECT_SINK').toString('base64')
  try {
    const fabric: Fabric = {
      slots: {
        ...defaultFabric().slots,
        vlm: [{ kind: 'http', name: 'redirecting-vlm', url: redirectingUrl, api: 'openai-compat' }],
      },
    }
    await assert.rejects(
      () => invokeVlm(fabric, { ...params, image: rawFrameSentinel }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateInvokeError)
        assert.equal(error.failures[0]?.class, 'bad-response')
        return true
      },
    )
    assert.equal(sink.bodies.length, 0, 'redirect target must never receive raw frame bytes')
  } finally {
    await new Promise<void>((resolve) => redirect.close(() => resolve()))
    await stop(sink)
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
    const result = await invokeVlm(fabric, params, { egress: resolveEgress({ contentClass: 'screen' }) })
    assert.equal(result.endpoint, 'loopback-vlm')
    assert.equal(result.text, 'described locally')
    assert.equal(result.egress?.destination, 'device-local')
    assert.equal(result.egress?.rawFrameTrust, undefined)
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
    const result = await invokeVlm(fabric, params, { egress: resolveEgress({ contentClass: 'screen' }) })
    assert.equal(result.endpoint, 'trusted-lan-vlm')
    assert.equal(result.text, 'described on the trusted box')
    assert.deepEqual(
      {
        reach: result.egress?.reach,
        destination: result.egress?.destination,
        rawFrameTrust: result.egress?.rawFrameTrust,
        allowed: result.egress?.allowed,
        decidedBy: result.egress?.decidedBy,
      },
      {
        reach: 'local',
        destination: 'lan-local',
        rawFrameTrust: 'explicit',
        allowed: false,
        decidedBy: 'content-class',
      },
    )
    assert.match(result.egress?.reason ?? '', /crossed the device boundary to an explicitly trusted LAN destination/)
    assert.deepEqual(attempted, [`${documentedUrl}/v1/chat/completions`])
  } finally {
    globalThis.fetch = originalFetch
    await stop(lanTarget)
  }
})

test('invokeVlm refuses untrusted LAN, public, malformed, and wildcard destinations before fetch', async () => {
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
          { kind: 'http', name: 'malformed-vlm', url: 'not a url', api: 'openai-compat', trustRawFrames: true },
          { kind: 'http', name: 'wildcard-vlm', url: 'http://[::]:8000', api: 'openai-compat', trustRawFrames: true },
        ],
      },
    }
    await assert.rejects(
      () => invokeVlm(fabric, params),
      (error: unknown) => {
        assert.ok(error instanceof AggregateInvokeError)
        assert.equal(error.failures.length, 4)
        assert.ok(error.failures.every((f) => f.class === 'egress-denied'))
        assert.match(error.message, /lan-vlm: raw screen frames are loopback-only — set trustRawFrames on this endpoint to allow it/)
        assert.match(error.message, /public-vlm: raw screen frames require a local-network host — public endpoint skipped despite trustRawFrames/)
        assert.match(error.message, /malformed-vlm: raw screen frames require a local-network host — public endpoint skipped despite trustRawFrames/)
        assert.match(error.message, /wildcard-vlm: raw screen frames require a real local-network host — a wildcard bind address is not a destination/)
        return true
      },
    )
    assert.deepEqual(attempted, [])
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
