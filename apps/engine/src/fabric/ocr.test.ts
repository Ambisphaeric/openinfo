import { createServer, type Server } from 'node:http'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Fabric, OcrInvokeParams } from '@openinfo/contracts'
import { defaultFabric } from './document.js'
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
    const result = await invokeOcr(fabric, params)
    assert.equal(result.endpoint, 'loopback-ocr')
    assert.equal(result.text, 'read locally')
    assert.deepEqual(attempted, [`${local.url}/predict/ocr_system`])
  } finally {
    globalThis.fetch = originalFetch
    await stop(local)
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
