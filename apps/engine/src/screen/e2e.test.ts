import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk, Distillate, Fabric, Flag, OcrResult, ScreenStatus } from '@openinfo/contracts'
import { createSecureTestEngineApp as createEngineApp, secureTestFetch as fetch } from '../api/test-control-plane.js'
import { wireScreenOcr } from './index.js'

/**
 * A fake paddle-serving OCR endpoint returning a fixed region list — the deterministic stand-in for a
 * real PaddleOCR runtime (the pipeline-shape fixture the slice requires; a live endpoint is exercised in
 * the standalone live-verification step, recorded in PHASE4-NOTES).
 */
const startFakePaddle = async (): Promise<{ server: Server; url: string }> => {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          status: '0',
          results: [[{ text: 'PR #128 — add OCR slot', confidence: 0.97, text_region: [[10, 10], [300, 10], [300, 40], [10, 40]] }]],
        }),
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, url: `http://127.0.0.1:${address.port}` }
}

const poll = async <T>(fn: () => Promise<T>, ok: (value: T) => boolean, tries = 50, everyMs = 40): Promise<T> => {
  let last: T = await fn()
  for (let i = 0; i < tries && !ok(last); i++) {
    await new Promise((resolve) => setTimeout(resolve, everyMs))
    last = await fn()
  }
  return last
}

test('e2e: POST /capture/screen → OCR → OcrResult via /screen/results + distillate on the standard feed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-screen-e2e-'))
  const paddle = await startFakePaddle()
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  const distillates: Distillate[] = []
  const ocrs: OcrResult[] = []
  // The WS feed for a distillate rides distillate.updated (there is no /query distillates source); the
  // engine-internal ocr.completed carries the raw result. Bind both to prove the processor publishes.
  app.bus.subscribe('distillate.updated', (d) => {
    distillates.push(d)
  })
  app.bus.subscribe('ocr.completed', (r) => {
    ocrs.push(r)
  })
  wireScreenOcr(app) // the same wiring main.ts does

  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  const address = app.server.address()
  assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`

  try {
    // Point the live fabric's ocr slot at the fake paddle (PUT /fabric edits the live fabric).
    const fabric: Fabric = {
      slots: { stt: [], tts: [], llm: [], vlm: [], embed: [], ocr: [{ kind: 'http', name: 'paddle', url: paddle.url, api: 'paddle-serving', model: 'pp-ocrv4' }] },
    }
    const fabricRes = await fetch(`${base}/fabric`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fabric) })
    assert.equal(fabricRes.status, 200)

    // Turn on screen.ocr through the real flag route (read per-frame by the processor).
    const flag: Flag = { key: 'screen.ocr', default: true, scope: 'engine', description: 'screen understanding' }
    const flagRes = await fetch(`${base}/flags/screen.ocr`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(flag) })
    assert.equal(flagRes.status, 200)

    // A screen frame (base64 image bytes) + its companion ScreenFrameMeta chunk, exactly as the client ships them.
    const image: CaptureChunk = {
      id: 'scr-sess-000001',
      sessionId: 'sess',
      workspaceId: 'default',
      source: 'screen',
      sequence: 1,
      capturedAt: '2026-07-08T12:00:00.000Z',
      contentType: 'image/jpeg',
      encoding: 'base64',
      data: Buffer.from('fake-jpeg-bytes').toString('base64'),
    }
    const meta: CaptureChunk = {
      id: 'scr-sess-000002',
      sessionId: 'sess',
      workspaceId: 'default',
      source: 'screen',
      sequence: 2,
      capturedAt: '2026-07-08T12:00:00.000Z',
      contentType: 'application/json',
      encoding: 'utf8',
      data: JSON.stringify({ displayId: '1', width: 800, height: 600 }),
    }
    for (const chunk of [image, meta]) {
      const res = await fetch(`${base}/capture/screen`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(chunk) })
      assert.equal(res.status, 200)
    }

    // Poll GET /screen/results until the async recognition lands.
    const results = await poll(
      async () => (await (await fetch(`${base}/screen/results?session=sess`)).json()) as OcrResult[],
      (rows) => rows.length > 0,
    )
    assert.equal(results.length, 1)
    assert.equal(results[0]!.text, 'PR #128 — add OCR slot')
    assert.equal(results[0]!.sourceChunks[0], 'scr-sess-000001')
    assert.equal(results[0]!.provenance.slot, 'ocr')
    assert.equal(results[0]!.provenance.endpoint, 'paddle')
    assert.equal(results[0]!.blocks?.length, 1)

    // The distillate reached the standard feed (distillate.updated) and carries the same recognized text.
    assert.equal(distillates.length, 1)
    assert.equal(distillates[0]!.text, 'PR #128 — add OCR slot')
    assert.equal(distillates[0]!.sourceChunks[0], 'scr-sess-000001')
    assert.equal(ocrs.length, 1)

    // GET /screen/status reflects the run: enabled, one processed, one skipped (the meta chunk), no failures.
    const status = (await (await fetch(`${base}/screen/status`)).json()) as ScreenStatus
    assert.equal(status.enabled, true)
    assert.equal(status.processed, 1)
    assert.equal(status.skipped, 1)
    assert.equal(status.failed, 0)
    assert.equal(status.lastFailures.length, 0)
  } finally {
    await app.close()
    await new Promise<void>((resolve) => paddle.server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})
