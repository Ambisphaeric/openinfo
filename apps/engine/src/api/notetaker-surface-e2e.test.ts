import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { BlockQuery, CaptureChunk, Fabric, QueryResult, Session, Summary, Surface } from '@openinfo/contracts'
import { createSecureTestEngineApp as createEngineApp, secureTestFetch as fetch } from './test-control-plane.js'

/**
 * #177/#211 (note-taker SURFACE): the actual shipped `surf-openinfo-notetaker` document, driven through the
 * SAME served entry points a client uses — GET /layouts/surfaces for the layout, POST /query per block for
 * the data. This is the served-UI-must-be-driven proof for THIS slice's two new wirings:
 *   1. the CENTER `nt-center-summary` block reads `source:'summaries'` at level `five-minute` (the memory
 *      headline), not the raw distillate stream — its own declared query hydrates a model PROPOSAL; and
 *   2. the LEFT `nt-left-sessions` block reads `source:'sessions'` — its own declared query hydrates the
 *      workspace's session history.
 * A real engine, a real fake loopback summarizer + stt, real capture POSTs, the real drain, the session
 * ENDED. No hand-rolled surface — the block queries come straight from the seeded document, so a drift in
 * the shipped wiring breaks this test. (The `session:'current'` → live-session binding is unit-covered by
 * query.ts #210; here the ended session is addressed by its id, exactly as the summaries-surface e2e does.)
 */

const TRANSCRIPT = 'we agreed to ship Thursday and Dana will send the deck by Friday'
const SUMMARY_PROSE = 'they agreed to ship Thursday; Dana owns the deck.'
const NOTETAKER_ID = 'surf-openinfo-notetaker'

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

/** POST the given block query under the note-taker app instance (?surface=<id>), like the client does. */
const runBlockQuery = async (base: string, query: BlockQuery): Promise<QueryResult> =>
  (await (await fetch(`${base}/query?surface=${NOTETAKER_ID}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(query),
  })).json()) as QueryResult

const driveSession = async (base: string): Promise<string> => {
  const started = (await (await fetch(`${base}/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: 'default', modeId: 'mode-meeting', title: 'note-taker surface e2e' }),
  })).json()) as Session
  const base0 = new Date('2026-07-16T14:00:00Z').getTime()
  const mkChunk = (seq: number, sec: number): CaptureChunk => ({
    id: `nt-audio-${seq}`, sessionId: started.id, workspaceId: 'default', source: 'mic', sequence: seq,
    capturedAt: new Date(base0 + sec * 1000).toISOString(), contentType: 'audio/webm', encoding: 'base64',
    data: Buffer.from('fake-webm-bytes').toString('base64'),
  })
  for (const c of [mkChunk(0, 5), mkChunk(1, 25)]) {
    await fetch(`${base}/capture/mic`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) })
  }
  await fetch(`${base}/sessions/${started.id}/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  return started.id
}

test('e2e (note-taker surface): the shipped document’s summary + sessions blocks hydrate over POST /query', async () => {
  const llm = await startFake(() => ({ choices: [{ message: { role: 'assistant', content: SUMMARY_PROSE } }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }))
  const stt = await startFake(() => ({ text: TRANSCRIPT }))
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-nt-surf-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`
    const fabric = (await (await fetch(`${base}/fabric`)).json()) as Fabric
    await fetch(`${base}/fabric`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slots: { ...fabric.slots, llm: [{ kind: 'http', name: 'llm.fast', url: llm.url, api: 'openai-compat', model: 'qwen3-8b' }], stt: [{ kind: 'http', name: 'whisper-box', url: stt.url, api: 'openai-compat', model: 'whisper-large-v3' }] } }),
    })
    for (const key of ['distill.enabled', 'distill.transcribe', 'summaries.enabled']) await enableFlag(base, key)

    // The layout comes from the SERVED endpoint the client reads — the seeded note-taker document (v2).
    const surfaces = (await (await fetch(`${base}/layouts/surfaces`)).json()) as Surface[]
    const notetaker = surfaces.find((s) => s.id === NOTETAKER_ID)
    assert.ok(notetaker, 'the note-taker surface is served')
    assert.equal(notetaker.version, 2)
    const summaryBlock = notetaker.stack.find((b) => b.id === 'nt-center-summary')
    const sessionsBlock = notetaker.stack.find((b) => b.id === 'nt-left-sessions')
    assert.ok(summaryBlock?.query && sessionsBlock?.query, 'the two new blocks declare queries')
    assert.equal(summaryBlock.query.source, 'summaries')
    assert.equal(summaryBlock.query.params['level'], 'five-minute')
    assert.equal(sessionsBlock.query.source, 'sessions')

    const sessionId = await driveSession(base)

    // (1) The CENTER summary block's OWN declared query (source+level from the document), bound to the driven
    // session, hydrates the model proposal — the notes surface reads a real summary, not the sentence stream.
    await eventually(async () => {
      const summaryQuery: BlockQuery = { ...summaryBlock.query!, params: { ...summaryBlock.query!.params, session: sessionId } }
      const items = (await runBlockQuery(base, summaryQuery)).items as Summary[]
      assert.ok(items.length >= 1, 'the five-minute summary hydrates through the note-taker summary block')
      assert.equal(items[0]!.level, 'five-minute')
      assert.equal(items[0]!.proposal, true, 'the prose is a model PROPOSAL, never canonical truth')
      assert.equal(items[0]!.text, SUMMARY_PROSE)
    })

    // (2) The LEFT sessions block's OWN declared query hydrates the workspace history — the driven session is
    // there (newest-first), realizing the rail folders that had no data before this slice.
    const sessions = (await runBlockQuery(base, sessionsBlock.query!)).items as Session[]
    assert.ok(sessions.some((s) => s.id === sessionId), 'the driven session appears in the note-taker sessions block')
    assert.ok(sessions[0]!.startedAt.length > 0, 'each session row carries a start time to render')
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
    await new Promise<void>((resolve) => llm.server.close(() => resolve()))
    await new Promise<void>((resolve) => stt.server.close(() => resolve()))
  }
})
