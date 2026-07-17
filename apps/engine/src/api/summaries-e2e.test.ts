import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk, Fabric, Session, Summary } from '@openinfo/contracts'
import { createSecureTestEngineApp as createEngineApp, secureTestFetch as fetch } from './test-control-plane.js'

/**
 * The #177 slice-1 DRIVEN e2e — the LIVE hierarchical-summary producer through the SERVED entry point. A
 * real engine server, real fake model servers on loopback (openai-compat llm + stt), real capture POSTs, the
 * real drain, then the session is ENDED — and the summaries materialize on their own, with NO POST
 * /summaries/build ever called. GET /summaries is then read exactly as a client would, asserting the levels
 * materialized, the prose is a model PROPOSAL, and every summary references its children (refs, not content).
 * A config change (editing the rolling template's bound over PUT /templates) is proven to change behavior.
 */

const TRANSCRIPT = 'we agreed to ship Thursday and Dana will send the deck by Friday'
const SUMMARY_PROSE = 'they agreed to ship Thursday; Dana owns the deck.'

const startFake = async (payload: () => unknown): Promise<{ server: Server; url: string }> => {
  const server = createServer((req, res) => {
    req.on('data', () => undefined)
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload()))
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

test('e2e (#177 summaries, served): a session materializes rolling + session summaries at end — no build route — each a model proposal referencing its children', async () => {
  const llm = await startFake(() => ({ choices: [{ message: { role: 'assistant', content: SUMMARY_PROSE } }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }))
  const stt = await startFake(() => ({ text: TRANSCRIPT }))
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-sum-e2e-'))
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
    for (const key of ['distill.enabled', 'distill.transcribe', 'summaries.enabled']) await enableFlag(base, key)

    const started = (await (await fetch(`${base}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'default', modeId: 'mode-meeting', title: 'summaries e2e' }),
    })).json()) as Session

    const base0 = new Date('2026-07-16T14:00:00Z').getTime()
    const mkChunk = (seq: number, sec: number): CaptureChunk => ({
      id: `sum-audio-${seq}`, sessionId: started.id, workspaceId: 'default', source: 'mic', sequence: seq,
      capturedAt: new Date(base0 + sec * 1000).toISOString(), contentType: 'audio/webm', encoding: 'base64',
      data: Buffer.from('fake-webm-bytes').toString('base64'),
    })
    for (const c of [mkChunk(0, 5), mkChunk(1, 25)]) {
      await fetch(`${base}/capture/mic`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) })
    }

    // END the session — the LIVE producer flushes the distill tail, then materializes rolling → five-minute →
    // session summaries, with NO POST /summaries/build. Poll the served GET /summaries until they appear.
    await fetch(`${base}/sessions/${started.id}/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })

    await eventually(async () => {
      const all = (await (await fetch(`${base}/summaries?session=${started.id}`)).json()) as Summary[]
      const session = all.find((s) => s.level === 'session')
      const rolling = all.find((s) => s.level === 'rolling')
      assert.ok(rolling, 'a rolling summary materialized over the distillates')
      assert.ok(session, 'the durable session summary materialized at session end')
      // The prose is a MODEL PROPOSAL, never canonical truth.
      assert.equal(session!.proposal, true)
      assert.equal(session!.text, SUMMARY_PROSE, 'the model prose is served')
      // Refs, not content: the rolling summary references distillates; nothing is copied.
      assert.ok(rolling!.children.length >= 1 && rolling!.children.every((c) => c.role === 'child' || c.role === 'evidence'))
      assert.ok(rolling!.children.some((c) => c.record === 'distillate'), 'rolling references the distillates it summarized')
      // The session summary is built from lower summaries (refs), and its bound is inspectable.
      assert.ok(session!.children.every((c) => c.record === 'summary'), 'session references lower-level summaries')
      assert.ok(session!.bound.childrenConsumed <= session!.bound.childrenAvailable)
    })

    // Query axes consistent with /context/packets: level filter narrows the served set.
    const rollingOnly = (await (await fetch(`${base}/summaries?session=${started.id}&level=rolling`)).json()) as Summary[]
    assert.ok(rollingOnly.length >= 1 && rollingOnly.every((s) => s.level === 'rolling'), 'the level filter is honored')

    // The on-demand build route STILL works and is idempotent over the already-materialized session.
    const rebuild = await fetch(`${base}/summaries/build`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'default', sessionId: started.id }),
    })
    assert.equal(rebuild.status, 200)
    assert.deepEqual(await rebuild.json(), [], 'the on-demand rebuild appends nothing — the live seam already converged it')

    // CONFIG CHANGES BEHAVIOR: tighten the rolling template's bound to 1 over PUT /templates, rebuild, and
    // the rolling summaries now supersede with childrenConsumed capped at 1 (the document, not code, decides).
    const rollingTpl = (await (await fetch(`${base}/templates/tpl-summary-rolling`)).json()) as { id: string; summary: Record<string, unknown> }
    await fetch(`${base}/templates/tpl-summary-rolling`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...rollingTpl, summary: { ...rollingTpl.summary, maxChildren: 1 } }),
    })
    await fetch(`${base}/summaries/build`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'default', sessionId: started.id, level: 'rolling' }),
    })
    const afterEdit = (await (await fetch(`${base}/summaries?session=${started.id}&level=rolling`)).json()) as Summary[]
    assert.ok(afterEdit.every((s) => s.bound.childrenConsumed <= 1), 'the edited bound took effect with no restart')
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
    await new Promise<void>((resolve) => llm.server.close(() => resolve()))
    await new Promise<void>((resolve) => stt.server.close(() => resolve()))
  }
})
