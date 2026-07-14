import { createServer, type Server } from 'node:http'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Fabric, OcrInvokeParams } from '@openinfo/contracts'
import { defaultFabric } from './document.js'
import { resolveEgress } from './egress.js'
import { invokeOcr } from './invoke.js'
import { AggregateInvokeError } from './invoke-error.js'

/** A PaddleHub ocr_system region — [box corners], text, confidence — as the real serving returns it. */
interface PaddleRegion {
  text: string
  confidence: number
  text_region: [number, number][]
}

interface FakePaddle {
  server: Server
  url: string
  paths: string[]
  bodies: string[]
}

/** A fake paddle-serving OCR endpoint that replies with a fixed per-image region list. */
const startFakePaddle = async (regions: PaddleRegion[], status = 200): Promise<FakePaddle> => {
  const paths: string[] = []
  const bodies: string[] = []
  const server = createServer((req, res) => {
    paths.push(req.url ?? '')
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'))
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(status === 200 ? JSON.stringify({ status: '0', results: [regions] }) : JSON.stringify({ error: 'paddle error' }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, url: `http://127.0.0.1:${address.port}`, paths, bodies }
}

const stop = (s: { server: Server }): Promise<void> => new Promise((resolve) => s.server.close(() => resolve()))

const params: OcrInvokeParams = { image: Buffer.from('PNGDATA').toString('base64'), contentType: 'image/png' }

test('invokeOcr POSTs the paddle-serving JSON shape and maps regions to blocks (text + confidence + pixel box)', async () => {
  const fake = await startFakePaddle([
    { text: 'File  Edit  View', confidence: 0.98, text_region: [[12, 8], [180, 8], [180, 30], [12, 30]] },
    { text: 'error: build failed', confidence: 0.91, text_region: [[12, 44], [220, 44], [220, 66], [12, 66]] },
  ])
  try {
    const fabric: Fabric = {
      slots: { ...defaultFabric().slots, ocr: [{ kind: 'http', name: 'paddle-box', url: fake.url, api: 'paddle-serving', model: 'pp-ocrv4' }] },
    }
    const result = await invokeOcr(fabric, params)
    assert.equal(result.slot, 'ocr')
    assert.equal(result.endpoint, 'paddle-box')
    assert.equal(result.model, 'pp-ocrv4')
    assert.equal(result.text, 'File  Edit  View\nerror: build failed') // flattened join of block texts
    assert.equal(result.blocks?.length, 2)
    assert.deepEqual(result.blocks?.[0], { text: 'File  Edit  View', confidence: 0.98, region: { x: 12, y: 8, width: 168, height: 22 } })
    assert.deepEqual(result.blocks?.[1], { text: 'error: build failed', confidence: 0.91, region: { x: 12, y: 44, width: 208, height: 22 } })
    // request: POST to the non-/v1 paddle path with {images:[base64]}
    assert.equal(fake.paths[0], '/predict/ocr_system')
    const body = JSON.parse(fake.bodies[0]!) as { images: string[] }
    assert.deepEqual(body.images, [params.image])
  } finally {
    await stop(fake)
  }
})

test('invokeOcr returns empty text + empty blocks for a frame with no text (a blank frame, not an error)', async () => {
  const fake = await startFakePaddle([])
  try {
    const fabric: Fabric = {
      slots: { ...defaultFabric().slots, ocr: [{ kind: 'http', name: 'paddle-box', url: fake.url, api: 'paddle-serving' }] },
    }
    const result = await invokeOcr(fabric, params)
    assert.equal(result.text, '')
    assert.deepEqual(result.blocks, [])
  } finally {
    await stop(fake)
  }
})

test('invokeOcr tolerates a region missing text/geometry: skips it, keeps a box-less region as text-only', async () => {
  const fake = await startFakePaddle([
    { text: 'ok', confidence: 0.9, text_region: [[0, 0], [10, 0], [10, 10], [0, 10]] },
    { confidence: 0.5, text_region: [[0, 0], [5, 5]] } as unknown as PaddleRegion, // no text → skipped
    { text: 'no box', confidence: 2, text_region: [] as unknown as [number, number][] }, // bad confidence + no corners → text only
  ])
  try {
    const fabric: Fabric = {
      slots: { ...defaultFabric().slots, ocr: [{ kind: 'http', name: 'paddle-box', url: fake.url, api: 'paddle-serving' }] },
    }
    const result = await invokeOcr(fabric, params)
    assert.equal(result.blocks?.length, 2)
    assert.deepEqual(result.blocks?.[0], { text: 'ok', confidence: 0.9, region: { x: 0, y: 0, width: 10, height: 10 } })
    assert.deepEqual(result.blocks?.[1], { text: 'no box' }) // out-of-range confidence and empty corners both dropped
    assert.equal(result.text, 'ok\nno box')
  } finally {
    await stop(fake)
  }
})

test('invokeOcr classifies a non-paddle 200 shape (no results array) as bad-response', async () => {
  const weird = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: '0' })) // no results
  })
  await new Promise<void>((resolve) => weird.listen(0, resolve))
  const address = weird.address()
  assert.ok(address && typeof address === 'object')
  const url = `http://127.0.0.1:${address.port}`
  try {
    const fabric: Fabric = {
      slots: { ...defaultFabric().slots, ocr: [{ kind: 'http', name: 'weird', url, api: 'paddle-serving' }] },
    }
    await assert.rejects(
      () => invokeOcr(fabric, params),
      (error: unknown) => {
        assert.ok(error instanceof AggregateInvokeError)
        assert.equal(error.slot, 'ocr')
        assert.equal(error.failures[0]?.class, 'bad-response')
        return true
      },
    )
  } finally {
    await stop({ server: weird })
  }
})

test('invokeOcr never retains a non-OK response body that echoes the submitted raw frame', async () => {
  const rawFrameSentinel = Buffer.from('RAW_FRAME_ECHO_SENTINEL_OCR_175').toString('base64')
  let receivedBody = ''
  const echo = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      receivedBody = Buffer.concat(chunks).toString('utf8')
      res.writeHead(500, { 'content-type': 'application/json' })
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
        ocr: [{ kind: 'http', name: 'echoing-paddle', url, api: 'paddle-serving', model: 'pp-ocrv4' }],
      },
    }
    await assert.rejects(
      () => invokeOcr(fabric, { ...params, image: rawFrameSentinel }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateInvokeError)
        assert.equal(error.slot, 'ocr')
        assert.equal(error.failures[0]?.class, 'model-load')
        assert.equal(error.failures[0]?.endpoint, 'echoing-paddle')
        assert.equal(error.failures[0]?.model, 'pp-ocrv4')
        assert.equal(error.failures[0]?.serverMessage, 'HTTP 500')
        assert.match(error.failures[0]?.hint ?? '', /model "pp-ocrv4" failed to load/)
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

test('invokeOcr falls through an unreachable paddle endpoint to a live one', async () => {
  const good = await startFakePaddle([{ text: 'second answered', confidence: 0.9, text_region: [[0, 0], [1, 0], [1, 1], [0, 1]] }])
  try {
    const fabric: Fabric = {
      slots: {
        ...defaultFabric().slots,
        ocr: [
          { kind: 'http', name: 'dead', url: 'http://127.0.0.1:1', api: 'paddle-serving' },
          { kind: 'http', name: 'live', url: good.url, api: 'paddle-serving' },
        ],
      },
    }
    const result = await invokeOcr(fabric, params, {})
    assert.equal(result.text, 'second answered')
    assert.equal(result.endpoint, 'live')
  } finally {
    await stop(good)
  }
})

test('invokeOcr refuses a 307 redirect before forwarding raw frame bytes', async () => {
  const sink = await startFakePaddle([
    { text: 'redirected OCR', confidence: 0.9, text_region: [[0, 0], [1, 0], [1, 1], [0, 1]] },
  ])
  const redirect = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(307, { location: `${sink.url}${req.url ?? '/predict/ocr_system'}` })
      res.end()
    })
  })
  await new Promise<void>((resolve) => redirect.listen(0, resolve))
  const address = redirect.address()
  assert.ok(address && typeof address === 'object')
  const redirectingUrl = `http://127.0.0.1:${address.port}`
  const rawFrameSentinel = Buffer.from('OCR_FRAME_MUST_NOT_REACH_REDIRECT_SINK').toString('base64')
  try {
    const fabric: Fabric = {
      slots: {
        ...defaultFabric().slots,
        ocr: [{ kind: 'http', name: 'redirecting-ocr', url: redirectingUrl, api: 'paddle-serving' }],
      },
    }
    await assert.rejects(
      () => invokeOcr(fabric, { ...params, image: rawFrameSentinel }),
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

test('invokeOcr sends raw frames only to loopback, skipping private-LAN and public HTTP endpoints before fetch', async () => {
  const local = await startFakePaddle([{ text: 'read locally', confidence: 0.9, text_region: [[0, 0], [1, 0], [1, 1], [0, 1]] }])
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
        ocr: [
          { kind: 'http', name: 'lan-ocr', url: 'http://192.168.1.50:8000', api: 'paddle-serving' },
          { kind: 'http', name: 'public-ocr', url: 'https://ocr.example.test', api: 'paddle-serving' },
          { kind: 'http', name: 'loopback-ocr', url: local.url, api: 'paddle-serving' },
        ],
      },
    }
    const result = await invokeOcr(fabric, params, { egress: resolveEgress({ contentClass: 'screen' }) })
    assert.equal(result.endpoint, 'loopback-ocr')
    assert.equal(result.text, 'read locally')
    assert.equal(result.egress?.destination, 'device-local')
    assert.equal(result.egress?.rawFrameTrust, undefined)
    assert.deepEqual(attempted, [`${local.url}/predict/ocr_system`])
  } finally {
    globalThis.fetch = originalFetch
    await stop(local)
  }
})

test('invokeOcr sends raw frames to a LAN endpoint the user explicitly flagged trustRawFrames', async () => {
  const lanTarget = await startFakePaddle([{ text: 'read on the trusted box', confidence: 0.9, text_region: [[0, 0], [1, 0], [1, 1], [0, 1]] }])
  const port = new URL(lanTarget.url).port
  const documentedUrl = `http://192.168.1.50:${port}`
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
        ocr: [{ kind: 'http', name: 'trusted-lan-ocr', url: documentedUrl, api: 'paddle-serving', trustRawFrames: true }],
      },
    }
    const result = await invokeOcr(fabric, params, { egress: resolveEgress({ contentClass: 'screen' }) })
    assert.equal(result.endpoint, 'trusted-lan-ocr')
    assert.equal(result.text, 'read on the trusted box')
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
    assert.deepEqual(attempted, [`${documentedUrl}/predict/ocr_system`])
  } finally {
    globalThis.fetch = originalFetch
    await stop(lanTarget)
  }
})

test('invokeOcr refuses untrusted LAN, public, malformed, and wildcard destinations before fetch', async () => {
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
        ocr: [
          { kind: 'http', name: 'lan-ocr', url: 'http://192.168.1.50:8000', api: 'paddle-serving' }, // no flag
          { kind: 'http', name: 'public-ocr', url: 'https://ocr.example.test', api: 'paddle-serving', trustRawFrames: true }, // flag cannot cross the LAN cap
          { kind: 'http', name: 'malformed-ocr', url: 'not a url', api: 'paddle-serving', trustRawFrames: true },
          { kind: 'http', name: 'wildcard-ocr', url: 'http://0.0.0.0:8000', api: 'paddle-serving', trustRawFrames: true },
        ],
      },
    }
    await assert.rejects(
      () => invokeOcr(fabric, params),
      (error: unknown) => {
        assert.ok(error instanceof AggregateInvokeError)
        assert.equal(error.failures.length, 4)
        assert.ok(error.failures.every((f) => f.class === 'egress-denied'))
        assert.match(error.message, /lan-ocr: raw screen frames are loopback-only — set trustRawFrames on this endpoint to allow it/)
        assert.match(error.message, /public-ocr: raw screen frames require a local-network host — public endpoint skipped despite trustRawFrames/)
        assert.match(error.message, /malformed-ocr: raw screen frames require a local-network host — public endpoint skipped despite trustRawFrames/)
        assert.match(error.message, /wildcard-ocr: raw screen frames require a real local-network host — a wildcard bind address is not a destination/)
        return true
      },
    )
    assert.deepEqual(attempted, [])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('invokeOcr injects a resolved keyRef as Authorization: Bearer on the paddle call', async () => {
  const seen: string[] = []
  const server = createServer((req, res) => {
    seen.push(String(req.headers['authorization'] ?? ''))
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ results: [[{ text: 'authed', confidence: 0.9, text_region: [[0, 0], [1, 0], [1, 1], [0, 1]] }]] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const url = `http://127.0.0.1:${address.port}`
  try {
    const fabric: Fabric = {
      slots: { ...defaultFabric().slots, ocr: [{ kind: 'http', name: 'remote-ocr', url, api: 'paddle-serving', auth: { keyRef: 'ocr-key' } }] },
    }
    const result = await invokeOcr(fabric, params, { resolveKey: (ref) => (ref === 'ocr-key' ? 'sk-ocr-7' : undefined) })
    assert.equal(result.text, 'authed')
    assert.equal(seen[0], 'Bearer sk-ocr-7')
  } finally {
    await stop({ server })
  }
})

test('invokeOcr times out a hanging paddle endpoint (classified timeout)', async () => {
  const slow = createServer(() => {
    /* never responds */
  })
  await new Promise<void>((resolve) => slow.listen(0, resolve))
  const address = slow.address()
  assert.ok(address && typeof address === 'object')
  const url = `http://127.0.0.1:${address.port}`
  try {
    const fabric: Fabric = {
      slots: { ...defaultFabric().slots, ocr: [{ kind: 'http', name: 'hang', url, api: 'paddle-serving' }] },
    }
    await assert.rejects(() => invokeOcr(fabric, { ...params, timeoutMs: 200 }), /timeout/)
  } finally {
    await stop({ server: slow })
  }
})

test('invokeOcr fills the ocr slot with an openai-compat VLM gracefully (dialect decides): prose, no blocks', async () => {
  const bodies: string[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      bodies.push(`${req.url ?? ''} ${Buffer.concat(chunks).toString('utf8')}`)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'the transcribed screen text' } }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const url = `http://127.0.0.1:${address.port}`
  try {
    const fabric: Fabric = {
      slots: { ...defaultFabric().slots, ocr: [{ kind: 'http', name: 'vlm-as-ocr', url, api: 'openai-compat', model: 'qwen2.5-vl-7b' }] },
    }
    const result = await invokeOcr(fabric, params)
    assert.equal(result.slot, 'ocr')
    assert.equal(result.text, 'the transcribed screen text')
    assert.equal(result.blocks, undefined) // a VLM produces prose, no region blocks
    // it went down the openai-compat vision-chat path (data URI), not the paddle path
    assert.match(bodies[0]!, /\/v1\/chat\/completions/)
    assert.match(bodies[0]!, /data:image\/png;base64,/)
  } finally {
    await stop({ server })
  }
})

test('invokeOcr throws AggregateInvokeError(slot: ocr) when the slot is empty and skips cloud/unsupported-local', async () => {
  const fabric: Fabric = {
    slots: {
      ...defaultFabric().slots,
      ocr: [
        { kind: 'local', name: 'paddle-local', runtime: 'paddle', model: 'pp-ocrv4' }, // unmanaged in v0 → falls through
        { kind: 'cloud', name: 'cloud-ocr', provider: 'google', auth: 'keychain' },
      ],
    },
  }
  await assert.rejects(
    () => invokeOcr(fabric, params),
    (error: unknown) => {
      assert.ok(error instanceof AggregateInvokeError)
      assert.equal(error.slot, 'ocr')
      return true
    },
  )
})
