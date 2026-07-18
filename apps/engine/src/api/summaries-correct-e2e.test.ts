import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk, Fabric, QueryResult, Session, Summary } from '@openinfo/contracts'
import { createSecureTestEngineApp as createEngineApp, secureTestFetch as fetch } from './test-control-plane.js'

/**
 * #246 DRIVEN SERVED e2e — the summary correction route end-to-end through the SERVED engine. A real engine,
 * a real fake loopback summarizer, real capture POSTs, the session ENDED so summaries materialize — then
 * POST /summaries/correct records a sovereign user revision, and GET /summaries (the read a client runs)
 * returns the USER text. Re-running POST /summaries/build (a full re-derivation) does NOT defeat it — the
 * correction still wins on read. An unknown summary id is a 404, not a silent success.
 */

const TRANSCRIPT = 'we agreed to ship Thursday and Dana will send the deck by Friday'
const SUMMARY_PROSE = 'they agreed to ship Thursday; Dana owns the deck.'
const CORRECTED = 'Dana owns the deck; we ship Thursday (confirmed).'

const startFake = async (payload: () => unknown): Promise<{ server: Server; url: string }> => {
  const server = createServer((req, res) => {
    req.on('data', () => undefined)
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload())) })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, url: `http://127.0.0.1:${address.port}` }
}
const enableFlag = async (base: string, key: string): Promise<void> => {
  await fetch(`${base}/flags/${key}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, default: true, scope: 'engine', description: key }) })
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
  const result = (await (await fetch(`${base}/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'summaries', params: { session: sessionId, level }, top: 5 }) })).json()) as QueryResult
  return result.items as Summary[]
}
const driveSession = async (base: string): Promise<string> => {
  const started = (await (await fetch(`${base}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: 'default', modeId: 'mode-meeting', title: 'summaries correct e2e' }) })).json()) as Session
  const base0 = new Date('2026-07-16T14:00:00Z').getTime()
  const mkChunk = (seq: number, sec: number): CaptureChunk => ({ id: `sc-${seq}`, sessionId: started.id, workspaceId: 'default', source: 'mic', sequence: seq, capturedAt: new Date(base0 + sec * 1000).toISOString(), contentType: 'audio/webm', encoding: 'base64', data: Buffer.from('fake-webm-bytes').toString('base64') })
  for (const c of [mkChunk(0, 5), mkChunk(1, 25)]) await fetch(`${base}/capture/mic`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) })
  await fetch(`${base}/sessions/${started.id}/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  return started.id
}

test('e2e (#246 served): POST /summaries/correct records a sovereign revision that GET /summaries returns and a re-build cannot defeat', async () => {
  const llm = await startFake(() => ({ choices: [{ message: { role: 'assistant', content: SUMMARY_PROSE } }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }))
  const stt = await startFake(() => ({ text: TRANSCRIPT }))
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-sum-correct-e2e-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`
    const fabric = (await (await fetch(`${base}/fabric`)).json()) as Fabric
    await fetch(`${base}/fabric`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slots: { ...fabric.slots, llm: [{ kind: 'http', name: 'llm.fast', url: llm.url, api: 'openai-compat', model: 'qwen3-8b' }], stt: [{ kind: 'http', name: 'whisper-box', url: stt.url, api: 'openai-compat', model: 'whisper-large-v3' }] } }) })
    for (const key of ['distill.enabled', 'distill.transcribe', 'summaries.enabled']) await enableFlag(base, key)

    const sessionId = await driveSession(base)
    // The five-minute machine proposal materializes.
    let target!: Summary
    await eventually(async () => {
      const five = await querySummaries(base, sessionId, 'five-minute')
      assert.ok(five.length >= 1 && five[0]!.text === SUMMARY_PROSE)
      target = five[0]!
    })

    // Correct it over the served route.
    const correctRes = await fetch(`${base}/summaries/correct`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: 'default', summaryId: target.id, text: CORRECTED, by: 'me' }) })
    assert.equal(correctRes.status, 200)
    const correction = (await correctRes.json()) as Summary
    assert.equal(correction.source, 'user')
    assert.equal(correction.text, CORRECTED)

    // The read a client runs now returns the USER text as the head.
    const afterCorrect = await querySummaries(base, sessionId, 'five-minute')
    assert.equal(afterCorrect.length, 1)
    assert.equal(afterCorrect[0]!.source, 'user')
    assert.equal(afterCorrect[0]!.text, CORRECTED)

    // A full re-derivation over the served build route cannot defeat the correction.
    await fetch(`${base}/summaries/build`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: 'default', sessionId, level: 'five-minute' }) })
    const afterRebuild = await querySummaries(base, sessionId, 'five-minute')
    assert.equal(afterRebuild.length, 1)
    assert.equal(afterRebuild[0]!.text, CORRECTED, 'the sovereign correction still wins after a served re-build')

    // An unknown summary id is a 404, never a silent success.
    const missing = await fetch(`${base}/summaries/correct`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: 'default', summaryId: 'sum-nope', text: 'x' }) })
    assert.equal(missing.status, 404)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
    await new Promise<void>((resolve) => llm.server.close(() => resolve()))
    await new Promise<void>((resolve) => stt.server.close(() => resolve()))
  }
})
