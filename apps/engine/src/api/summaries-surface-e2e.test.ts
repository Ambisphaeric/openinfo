import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk, Fabric, QueryResult, Session, Summary } from '@openinfo/contracts'
import { createSecureTestEngineApp as createEngineApp, secureTestFetch as fetch } from './test-control-plane.js'

/**
 * #177 slice 2 — the DEFAULT-HUMAN-UI emphasis, driven through the SERVED entry point the HUD block reads:
 * POST /query with `source: 'summaries'`. A real engine, a real fake loopback summarizer, real capture POSTs,
 * the real drain, the session ENDED — then the surface's own query for the five-minute VIEW and the session
 * result returns model-PROPOSAL summaries (the human headline), exactly what the `summaries` HUD block hydrates.
 * (The HONEST degraded path the block renders is proven by summaries-egress-seam.test.ts — a real producer
 * persisting degraded summaries when the model is unavailable — and by the client summaries.test.ts renderer.)
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

const querySummaries = async (base: string, sessionId: string, level: string): Promise<Summary[]> => {
  const result = (await (await fetch(`${base}/query`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'summaries', params: { session: sessionId, level }, top: 5 }),
  })).json()) as QueryResult
  return result.items as Summary[]
}

const driveSession = async (base: string, stt: { url: string }): Promise<string> => {
  const started = (await (await fetch(`${base}/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: 'default', modeId: 'mode-meeting', title: 'summaries surface e2e' }),
  })).json()) as Session
  const base0 = new Date('2026-07-16T14:00:00Z').getTime()
  const mkChunk = (seq: number, sec: number): CaptureChunk => ({
    id: `surf-audio-${seq}`, sessionId: started.id, workspaceId: 'default', source: 'mic', sequence: seq,
    capturedAt: new Date(base0 + sec * 1000).toISOString(), contentType: 'audio/webm', encoding: 'base64',
    data: Buffer.from('fake-webm-bytes').toString('base64'),
  })
  for (const c of [mkChunk(0, 5), mkChunk(1, 25)]) {
    await fetch(`${base}/capture/mic`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) })
  }
  await fetch(`${base}/sessions/${started.id}/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  return started.id
}

test('e2e (#177 surface): POST /query source:summaries serves the five-minute + session views as model proposals — the HUD headline', async () => {
  const llm = await startFake(() => ({ choices: [{ message: { role: 'assistant', content: SUMMARY_PROSE } }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }))
  const stt = await startFake(() => ({ text: TRANSCRIPT }))
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-sum-surf-'))
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

    const sessionId = await driveSession(base, stt)

    // The surface query a user's HUD runs: the five-minute VIEW is the human headline.
    await eventually(async () => {
      const five = await querySummaries(base, sessionId, 'five-minute')
      assert.ok(five.length >= 1, 'the five-minute summary surfaces through source:summaries')
      assert.equal(five[0]!.proposal, true, 'the prose is a model PROPOSAL, never canonical truth')
      assert.equal(five[0]!.text, SUMMARY_PROSE, 'the served prose is the model output')
    })
    // The durable session result is also queryable as its own level (the HUD's second summaries card).
    const session = await querySummaries(base, sessionId, 'session')
    assert.ok(session.length === 1 && session[0]!.level === 'session', 'the session summary surfaces as its own level')
    assert.ok(session[0]!.children.every((c) => c.record === 'summary'), 'refs only — the session view points at lower summaries')
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
    await new Promise<void>((resolve) => llm.server.close(() => resolve()))
    await new Promise<void>((resolve) => stt.server.close(() => resolve()))
  }
})
