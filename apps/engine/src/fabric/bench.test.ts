import { createServer, type Server } from 'node:http'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Fabric } from '@openinfo/contracts'
import { defaultFabric } from './document.js'
import { benchFabric, benchHttpEndpoint } from './bench.js'

/** A server that answers any GET 200 — enough for checkEndpoint to measure a latency. */
const startOk = async (): Promise<{ server: Server; url: string }> => {
  const server = createServer((_req, res) => {
    res.writeHead(200)
    res.end('ok')
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, url: `http://127.0.0.1:${address.port}` }
}

const stop = (server: Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()))

test('benchFabric measures the ocr AND vlm slots (every slot, not just llm/stt) with a real latency', async () => {
  const ocr = await startOk()
  const vlm = await startOk()
  try {
    const fabric: Fabric = {
      slots: {
        ...defaultFabric().slots,
        ocr: [{ kind: 'http', name: 'paddle-box', url: ocr.url, api: 'paddle-serving' }],
        vlm: [{ kind: 'http', name: 'vlm-box', url: vlm.url, api: 'openai-compat', model: 'qwen2.5-vl-7b' }],
      },
    }
    const benched = await benchFabric(fabric)
    const ocrEp = benched.slots.ocr[0]!
    const vlmEp = benched.slots.vlm[0]!
    assert.equal(typeof ocrEp.measured?.latencyMs, 'number', 'the ocr endpoint must be benched with a measured latency')
    assert.ok(ocrEp.measured?.measuredAt, 'the ocr endpoint must carry a measuredAt timestamp')
    assert.equal(typeof vlmEp.measured?.latencyMs, 'number', 'the vlm endpoint must be benched with a measured latency')
    assert.ok(vlmEp.measured?.measuredAt, 'the vlm endpoint must carry a measuredAt timestamp')
  } finally {
    await stop(ocr.server)
    await stop(vlm.server)
  }
})

test('benchHttpEndpoint stamps a paddle-serving ocr endpoint (measured is dialect-agnostic)', async () => {
  const ocr = await startOk()
  try {
    const endpoint = { kind: 'http', name: 'paddle-box', url: ocr.url, api: 'paddle-serving' } as const
    const benched = await benchHttpEndpoint(endpoint)
    assert.equal(benched.kind, 'http')
    assert.equal(typeof benched.measured?.latencyMs, 'number')
  } finally {
    await stop(ocr.server)
  }
})

test('benchHttpEndpoint leaves a non-http (local) ocr endpoint untouched (nothing to measure)', async () => {
  const endpoint = { kind: 'local', name: 'paddle-local', runtime: 'paddle', model: 'pp-ocrv4' } as const
  const benched = await benchHttpEndpoint(endpoint)
  assert.deepEqual(benched, endpoint) // pass-through, no measured stamp
})
