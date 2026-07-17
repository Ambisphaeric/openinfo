import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk, Fabric, Session } from '@openinfo/contracts'
import { createSecureTestEngineApp as createEngineApp, secureTestFetch as fetch } from './test-control-plane.js'
import { wireScreenOcr } from '../screen/index.js'

/**
 * The #116/#207 trace-view SCREEN sibling of api/trace-e2e.test.ts — the screen input driven through the
 * SERVED entry point, not route internals. A real engine server (secure test control plane), the SAME
 * screen wiring main.ts does (`wireScreenOcr`, NO injected invoke so the REAL processor drives the fabric
 * `ocr` slot), a fake loopback paddle-serving OCR endpoint (the deterministic stand-in for a live
 * PaddleOCR runtime, mirroring the mic e2e's fake stt/llm/judge servers), real `/capture/screen` POSTs,
 * then the trace is walked exactly as a browser would: GET /settings/trace, follow the input link the page
 * itself serves, and read the hop chain off the HTML.
 *
 * It proves the screen half of the Trace walk end to end through PRODUCTION code: a recognized frame
 * renders its `seen` OCR hop (with the recorded device-local egress + usage-derived timing) followed by
 * the shared-span mirror hop labeled "no second model call" — and a BLANK frame, which the real processor
 * persists as a checkpoint OcrResult with NO mirror Distillate, renders its `seen` recognition with no
 * downstream hop (the honest "nothing further happened" state), never a blank page. No synthetic record is
 * injected past the capture seam; every OcrResult + mirror is built by the real ScreenOcrProcessor.
 */

const RECOGNIZED_TEXT = 'Sprint planning board'

/**
 * A fake paddle-serving OCR endpoint. It decodes the posted frame and answers deterministically: a frame
 * whose bytes carry the BLANK marker recognizes as empty (a normal blank outcome — no region list); every
 * other frame yields one recognized region. No token usage is reported (paddle never does), so the real
 * invoke estimates it (chars/4) — exactly the live shape.
 */
const startFakePaddle = async (): Promise<{ server: Server; url: string }> => {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { images: string[] }
      const frame = Buffer.from(body.images[0] ?? '', 'base64').toString('utf8')
      const blank = frame.includes('BLANK')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          status: '0',
          results: blank
            ? [[]]
            : [[{ text: RECOGNIZED_TEXT, confidence: 0.96, text_region: [[10, 10], [300, 10], [300, 40], [10, 40]] }]],
        }),
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, url: `http://127.0.0.1:${address.port}` }
}

const enableFlag = async (base: string, key: string): Promise<void> => {
  await fetch(`${base}/flags/${key}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, default: true, scope: 'engine', description: key }),
  })
}

const eventually = async (assertion: () => Promise<void>, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try { await assertion(); return } catch (error) { lastError = error; await new Promise((r) => setTimeout(r, 50)) }
  }
  throw lastError instanceof Error ? lastError : new Error('condition not met')
}

/** The picker anchors carry both the input id (in the href) and its human label — pair them up. */
const captureInputs = (html: string): { id: string; label: string }[] =>
  [...html.matchAll(/href="\/settings\/trace\?input=([^"]+)"><span class="trc-input-label">([^<]+)<\/span>/g)]
    .map((m) => ({ id: decodeURIComponent(m[1]!), label: m[2]! }))
    .filter((input) => input.label.startsWith('Screen · '))

test('e2e (#207 trace view, served): a screen frame walks seen → mirror on the page a browser gets, and a blank frame walks to nothing further', async () => {
  const paddle = await startFakePaddle()
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-screen-trace-e2e-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  wireScreenOcr(app) // the same wiring main.ts does — NO injected invoke, so the REAL processor runs
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    // Point the live fabric's ocr slot at the fake paddle (PUT /fabric edits the live fabric the processor loads).
    const fabric = (await (await fetch(`${base}/fabric`)).json()) as Fabric
    await fetch(`${base}/fabric`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slots: { ...fabric.slots, ocr: [{ kind: 'http', name: 'paddle', url: paddle.url, api: 'paddle-serving', model: 'pp-ocrv4' }] },
      }),
    })
    await enableFlag(base, 'screen.ocr')

    // FRESH-INSTALL STATE FIRST: before anything is captured, the served page explains itself — no blank.
    const before = await (await fetch(`${base}/settings/trace`)).text()
    assert.match(before, /Nothing to trace yet/)
    assert.match(before, /enable screen understanding/)

    const started = (await (await fetch(`${base}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'default', modeId: 'mode-meeting', title: 'screen trace e2e' }),
    })).json()) as Session

    // A recognized frame + its companion ScreenFrameMeta chunk + a blank frame — exactly as the client ships them.
    const frame = (id: string, seq: number, sec: number, marker: string): CaptureChunk => ({
      id, sessionId: started.id, workspaceId: 'default', source: 'screen', sequence: seq,
      capturedAt: new Date(new Date('2026-07-14T09:00:00Z').getTime() + sec * 1000).toISOString(),
      contentType: 'image/jpeg', encoding: 'base64', data: Buffer.from(marker).toString('base64'),
    })
    const meta: CaptureChunk = {
      id: 'scr-meta-1', sessionId: started.id, workspaceId: 'default', source: 'screen', sequence: 2,
      capturedAt: '2026-07-14T09:00:00.000Z', contentType: 'application/json', encoding: 'utf8',
      data: JSON.stringify({ displayId: '1', width: 1280, height: 800 }),
    }
    const chunks: CaptureChunk[] = [
      frame('scr-recognized-1', 1, 0, 'SCREEN-FRAME-RECOGNIZED'),
      meta,
      frame('scr-blank-1', 3, 5, 'SCREEN-FRAME-BLANK'),
    ]
    for (const chunk of chunks) {
      const res = await fetch(`${base}/capture/screen`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(chunk) })
      assert.equal(res.status, 200)
    }

    // ---- 1) the picker fills from the REAL screen processor: both captures (the meta chunk yields none) ----
    let recognized: { id: string; label: string } | undefined
    let blank: { id: string; label: string } | undefined
    await eventually(async () => {
      const html = await (await fetch(`${base}/settings/trace`)).text()
      const inputs = captureInputs(html)
      recognized = inputs.find((i) => /Screen · [1-9]/.test(i.label))
      blank = inputs.find((i) => i.label === 'Screen · 0 characters recognized')
      assert.ok(recognized !== undefined, `expected a recognized capture input, saw ${JSON.stringify(inputs.map((i) => i.label))}`)
      assert.ok(blank !== undefined, `expected a blank capture input, saw ${JSON.stringify(inputs.map((i) => i.label))}`)
    })
    assert.equal(recognized!.label, `Screen · ${RECOGNIZED_TEXT.length} characters recognized`)

    // ---- 2) follow the recognized capture's own link: the seen OCR hop + the shared-span mirror hop ----
    const recognizedHtml = await (await fetch(`${base}/settings/trace?input=${encodeURIComponent(recognized!.id)}`)).text()
    assert.match(recognizedHtml, /Recognized what was on screen/, 'the root recognition: the seen hop')
    assert.match(recognizedHtml, new RegExp(RECOGNIZED_TEXT), 'the text the fake OCR recognized renders on the seen hop')
    assert.match(recognizedHtml, /paddle · pp-ocrv4 · [\d,]+ms/, 'the seen hop names the ocr endpoint/model and the recorded invoke timing (#65 usage)')
    assert.match(recognizedHtml, /device-local/, 'the seen hop carries its recorded device-local egress decision (#64/#196)')
    assert.match(recognizedHtml, /not applicable · device-local/, 'no fabricated guard verdict for a device-local raw-frame hop — the honest absence (#63/#206)')
    assert.match(recognizedHtml, /Published to the summary stream/, 'the shared-span mirror rides the SAME recognition pass into the summary stream')
    assert.match(recognizedHtml, /no second model call/, 'the mirror is labeled as one pass, not misreported as another invoke (#116)')

    // ---- 3) the blank frame: the real processor persisted a checkpoint OcrResult with NO mirror. Its trail
    //         is its own recognition and nothing further — the honest "capture with no downstream hops" ----
    const blankHtml = await (await fetch(`${base}/settings/trace?input=${encodeURIComponent(blank!.id)}`)).text()
    assert.match(blankHtml, /Recognized what was on screen/, 'a blank frame still has its recognition hop')
    assert.doesNotMatch(blankHtml, /Published to the summary stream/, 'a blank frame produces NO mirror — no downstream summary hop is invented')
    assert.doesNotMatch(blankHtml, new RegExp(RECOGNIZED_TEXT), 'the blank trail never leaks the other frame recognized text')

    // ---- 4) the real processor's health confirms it drove the production path: one processed, one blank,
    //         one skipped (the meta chunk), no failures ----
    const status = (await (await fetch(`${base}/screen/status`)).json()) as { processed: number; blank: number; skipped: number; failed: number }
    assert.equal(status.processed, 1, 'one recognized frame processed')
    assert.equal(status.blank, 1, 'one blank frame counted')
    assert.equal(status.skipped, 1, 'the companion meta chunk was skipped')
    assert.equal(status.failed, 0, 'no failures on the driven path')
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
    await new Promise<void>((resolve) => paddle.server.close(() => resolve()))
  }
})
