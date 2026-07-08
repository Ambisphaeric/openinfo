import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk, Distillate, Fabric, Flag, OcrResult, ScreenStatus } from '@openinfo/contracts'
import { createEngineApp } from '../api/http.js'
import { wireScreenOcr } from './index.js'

/**
 * P4A×P4B JOINT-SLICE e2e: screen understanding folded into the workflow executor as an `ocr` DRAIN step.
 * With workflow.enabled ON, a screen frame is recognized on the queue DRAIN (executor.runDrain →
 * recognizeScreen → the registered processor's runOnDrain over the fabric ocr slot), NOT on capture
 * ingest. The single-result assertion is the double-processing proof: even with BOTH workflow.enabled and
 * screen.ocr ON, the frame is recognized EXACTLY once because the ingest subscription defers to the
 * executor. (The legacy ingest path — workflow.enabled OFF — is covered by e2e.test.ts.)
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
          results: [[{ text: 'issue #42 — flaky drain test', confidence: 0.95, text_region: [[8, 8], [280, 8], [280, 36], [8, 36]] }]],
        }),
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, url: `http://127.0.0.1:${address.port}` }
}

const poll = async <T>(fn: () => Promise<T>, ok: (value: T) => boolean, tries = 60, everyMs = 40): Promise<T> => {
  let last: T = await fn()
  for (let i = 0; i < tries && !ok(last); i++) {
    await new Promise((resolve) => setTimeout(resolve, everyMs))
    last = await fn()
  }
  return last
}

const putFlag = async (base: string, key: string): Promise<void> => {
  const flag: Flag = { key, default: true, scope: 'engine', description: key }
  const res = await fetch(`${base}/flags/${key}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(flag) })
  assert.equal(res.status, 200)
}

test('e2e: workflow.enabled ON drains a screen frame through the ocr step → exactly one OcrResult (no double-processing)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-screen-wf-e2e-'))
  const paddle = await startFakePaddle()
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  const distillates: Distillate[] = []
  app.bus.subscribe('distillate.updated', (d) => {
    distillates.push(d)
  })
  wireScreenOcr(app) // the same wiring main.ts does; its ingest subscription must DEFER when workflow.enabled is ON

  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  const address = app.server.address()
  assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`

  try {
    // Point the live fabric's ocr slot at the fake paddle.
    const fabric: Fabric = {
      slots: { stt: [], tts: [], llm: [], vlm: [], embed: [], ocr: [{ kind: 'http', name: 'paddle', url: paddle.url, api: 'paddle-serving', model: 'pp-ocrv4' }] },
    }
    assert.equal((await fetch(`${base}/fabric`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fabric) })).status, 200)

    // BOTH flags ON — the double-processing guard is what keeps this to a single result.
    await putFlag(base, 'workflow.enabled')
    await putFlag(base, 'screen.ocr')

    const image: CaptureChunk = {
      id: 'scr-wf-000001', sessionId: 'wf', workspaceId: 'default', source: 'screen', sequence: 1,
      capturedAt: '2026-07-08T13:00:00.000Z', contentType: 'image/jpeg', encoding: 'base64',
      data: Buffer.from('fake-jpeg-bytes').toString('base64'),
    }
    const meta: CaptureChunk = {
      id: 'scr-wf-000002', sessionId: 'wf', workspaceId: 'default', source: 'screen', sequence: 2,
      capturedAt: '2026-07-08T13:00:00.000Z', contentType: 'application/json', encoding: 'utf8',
      data: JSON.stringify({ displayId: '1', width: 800, height: 600 }),
    }
    for (const chunk of [image, meta]) {
      assert.equal((await fetch(`${base}/capture/screen`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(chunk) })).status, 200)
    }

    // Poll GET /screen/results until the DRAIN recognition lands (store-backed, so the workflow-produced
    // OcrResult surfaces on the same read route as the ingest path).
    const results = await poll(
      async () => (await (await fetch(`${base}/screen/results?session=wf`)).json()) as OcrResult[],
      (rows) => rows.length > 0,
    )
    // EXACTLY one: the drain path recognized it once; the ingest path deferred (workflow.enabled ON).
    assert.equal(results.length, 1)
    assert.equal(results[0]!.text, 'issue #42 — flaky drain test')
    assert.equal(results[0]!.sourceChunks[0], 'scr-wf-000001')
    assert.equal(results[0]!.provenance.slot, 'ocr')
    assert.equal(results[0]!.provenance.endpoint, 'paddle')
    assert.equal(results[0]!.blocks?.length, 1)

    // The distillate reached the standard feed exactly once, carrying the recognized text.
    assert.equal(distillates.filter((d) => d.sourceChunks[0] === 'scr-wf-000001').length, 1)

    // Give any (wrongly) scheduled second pass a beat, then re-confirm still exactly one — no double-processing.
    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.equal(((await (await fetch(`${base}/screen/results?session=wf`)).json()) as OcrResult[]).length, 1)

    // /screen/status reflects the drain path (runOnDrain feeds the SAME processor's counters): the frame
    // was processed, none failed. The image and its companion meta chunk can drain in separate batches
    // (the meta may not be re-drained), so `skipped` is incidental here and not asserted — the ingest
    // e2e (e2e.test.js) covers the deterministic meta-skip; this test's point is the drain-owned OcrResult.
    const status = (await (await fetch(`${base}/screen/status`)).json()) as ScreenStatus
    assert.equal(status.processed, 1)
    assert.equal(status.failed, 0)
  } finally {
    await app.close()
    await new Promise<void>((resolve) => paddle.server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})
