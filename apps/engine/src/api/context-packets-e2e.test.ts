import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import type { CaptureChunk, Fabric, Session } from '@openinfo/contracts'
import { createSecureTestEngineApp as createEngineApp, secureTestFetch as fetch } from './test-control-plane.js'

/**
 * The #176 slice-2 DRIVEN e2e — the LIVE producer through the SERVED entry point. A real engine server,
 * real fake model servers on loopback (openai-compat llm + stt), real capture POSTs through /capture/mic,
 * the real dual-track drain, then the session is ENDED — and the packets materialize on their own, with NO
 * POST /context/packets/build ever called. The Context-packets diagnostics page is then read exactly as a
 * browser would: GET /settings/context-packets, asserting membership, exclusions, timing, and confidence
 * render on the HTML the page serves. A sabotage path proves an assembly failure surfaces as visible text.
 *
 * This is the served proof the repo lesson demands: a green route test is not enough — the surface a
 * browser actually gets must show the converged slice, and its degraded states must be reachable text.
 */

const TRANSCRIPT = 'we should ship Thursday and Dana will send the board deck by Friday'

const startFakeLlm = async (): Promise<{ server: Server; url: string }> => {
  const server = createServer((req, res) => {
    req.on('data', () => undefined)
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'they agreed to ship Thursday.' } }], usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, url: `http://127.0.0.1:${address.port}` }
}

const startFakeStt = async (): Promise<{ server: Server; url: string }> => {
  const server = createServer((req, res) => {
    req.on('data', () => undefined)
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ text: TRANSCRIPT }))
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

const eventually = async (assertion: () => Promise<void>, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try { await assertion(); return } catch (error) { lastError = error; await new Promise((r) => setTimeout(r, 50)) }
  }
  throw lastError instanceof Error ? lastError : new Error('condition not met')
}

test('e2e (#176 context packets, served): a session materializes packets at end — no build route — and the page shows membership, exclusions, timing, confidence', async () => {
  const llm = await startFakeLlm()
  const stt = await startFakeStt()
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-packets-e2e-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    const fabric = (await (await fetch(`${base}/fabric`)).json()) as Fabric
    await fetch(`${base}/fabric`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slots: {
          ...fabric.slots,
          llm: [{ kind: 'http', name: 'llm.fast', url: llm.url, api: 'openai-compat', model: 'qwen3-8b' }],
          stt: [{ kind: 'http', name: 'whisper-box', url: stt.url, api: 'openai-compat', model: 'whisper-large-v3' }],
        },
      }),
    })
    for (const key of ['distill.enabled', 'distill.transcribe']) await enableFlag(base, key)

    // FRESH-INSTALL STATE FIRST: before anything is captured, the served page explains itself — no blank.
    const before = await (await fetch(`${base}/settings/context-packets`)).text()
    assert.match(before, /No context packets yet/)
    assert.match(before, /Start a session with listening or screen understanding on/)

    const started = (await (await fetch(`${base}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'default', modeId: 'mode-meeting', title: 'packets e2e' }),
    })).json()) as Session
    // Two mic chunks inside the SAME minute window → one packet whose mic lane holds both.
    const base0 = new Date('2026-07-13T14:00:00Z').getTime()
    const mkChunk = (seq: number, sec: number): CaptureChunk => ({
      id: `pkt-audio-${seq}`, sessionId: started.id, workspaceId: 'default', source: 'mic', sequence: seq,
      capturedAt: new Date(base0 + sec * 1000).toISOString(), contentType: 'audio/webm', encoding: 'base64',
      data: Buffer.from('fake-webm-bytes').toString('base64'),
    })
    for (const c of [mkChunk(0, 5), mkChunk(1, 25)]) {
      await fetch(`${base}/capture/mic`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) })
    }

    // END the session — the LIVE producer materializes packets from the drained observations, with NO
    // POST /context/packets/build. Poll the SERVED page until the converged window appears.
    await fetch(`${base}/sessions/${started.id}/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })

    await eventually(async () => {
      const html = await (await fetch(`${base}/settings/context-packets`)).text()
      // MEMBERSHIP: the microphone lane, with both in-window utterances counted.
      assert.match(html, /Microphone/, 'the mic lane rendered')
      assert.match(html, /2 heard/, 'both in-window utterances counted in the mic lane')
      // TIMING: the window clock span the packet was bucketed into.
      assert.match(html, /14:00:00–14:01:00/, 'the correlation window bounds render')
      // EXCLUSIONS: the two silent lanes degrade honestly with a human reason.
      assert.match(html, /System audio — nothing captured this session/, 'a missing sense names its reason')
      assert.match(html, /Screen — nothing captured this session/, 'the screen gap is honest, not blank')
      // CONFIDENCE: framed in human words (a single contributing sense).
      assert.match(html, /one sense/, 'confidence framed by contributing senses')
      // The live producer's honest "last update" line proves the seam ran without the route.
      assert.match(html, /Last update/, 'the live build outcome renders')
    })

    // The on-demand route STILL works and is idempotent over the already-materialized session.
    const rebuild = await fetch(`${base}/context/packets/build`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'default', sessionId: started.id }),
    })
    assert.equal(rebuild.status, 200)
    assert.deepEqual(await rebuild.json(), [], 'the on-demand rebuild appends nothing — the live seam already converged it')

    // SABOTAGE: a corrupted packet row surfaces the TRUE reason as visible text, never a blank section.
    const db = new Database(join(dir, 'default.db'))
    db.prepare("insert or replace into context_packets (id, session_id, window_start, window_end, created_at, body) values ('bad', ?, '2026-07-13T14:00:00.000Z', '2026-07-13T14:01:00.000Z', '2026-07-13T14:01:01.000Z', '{not json')").run(started.id)
    db.close()
    const broken = await (await fetch(`${base}/settings/context-packets`)).text()
    assert.match(broken, /Context packets unavailable/)
    assert.match(broken, /The grouped activity can’t be read right now/)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
    await new Promise<void>((resolve) => llm.server.close(() => resolve()))
    await new Promise<void>((resolve) => stt.server.close(() => resolve()))
  }
})
