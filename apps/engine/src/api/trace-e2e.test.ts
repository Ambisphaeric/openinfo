import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import type { CaptureChunk, Fabric, Session } from '@openinfo/contracts'
import { FieldValueStore } from '../distill/field-values.js'
import { createSecureTestEngineApp as createEngineApp, secureTestFetch as fetch } from './test-control-plane.js'

/**
 * The #116 trace-view DRIVEN e2e — through the SERVED entry point, not route internals. A real engine
 * server (secure test control plane), real fake model servers on loopback (openai-compat llm + stt), real
 * capture POSTs through /capture/mic, the real dual-track drain (transcribe → distill → moments → fields
 * → judge), then the trace is walked exactly as a browser would: GET /settings/trace, follow the input
 * link the page itself serves, and read the hop chain off the HTML. Sabotage paths prove failures surface
 * as visible text (unknown input; a corrupted record store), never a blank.
 *
 * Deterministic stand-in for the owner-gated live-rig DoD item ("pick a real parakeet utterance from a
 * live session") — same pipeline, same served page, fake model servers instead of real hardware.
 */

// The judge accumulates ~a minute of source by default; release it per batch so this e2e sees the judge
// hop deterministically. Read once at wiring, so it must be set BEFORE createEngineApp.
process.env['OPENINFO_JUDGE_CADENCE_MS'] = '0'

const TRANSCRIPT = 'we should ship Thursday, Dana will send the board deck to Priya by Friday and schedule the vendor security review'

/** One fake openai-compat model server, four jobs told apart by their template bodies. */
const startFakeLlm = async (): Promise<{ server: Server; url: string }> => {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: { content: string }[] }
      const prompt = body.messages[0]!.content
      const content = prompt.includes('JSON array of verdicts')
        ? '[{"fieldId": "field-topic", "verdict": "confirm"}]'
        : prompt.includes('JSON array of entities')
          ? '[{"kind": "person", "name": "Dana"}]'
          : prompt.includes('Return ONLY a JSON array')
            ? '[{"kind": "commitment", "text": "ship Thursday", "confidence": 0.85}]'
            : 'they agreed to ship Thursday.'
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 210, completion_tokens: 34, total_tokens: 244 } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, url: `http://127.0.0.1:${address.port}` }
}

/** A fake openai-compat STT server returning one fixed transcript. */
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

const eventually = async (assertion: () => Promise<void>, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try { await assertion(); return } catch (error) { lastError = error; await new Promise((r) => setTimeout(r, 50)) }
  }
  throw lastError instanceof Error ? lastError : new Error('condition not met')
}

test('e2e (#116 trace view, served): an utterance walks heard → summary → moment → field → judge on the page a browser gets', async () => {
  const llm = await startFakeLlm()
  const stt = await startFakeStt()
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-trace-e2e-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    // A rig shape with every lane this trace crosses: fast llm, judge llm, stt.
    const fabric = (await (await fetch(`${base}/fabric`)).json()) as Fabric
    await fetch(`${base}/fabric`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slots: {
          ...fabric.slots,
          llm: [
            { kind: 'http', name: 'llm.fast', url: llm.url, api: 'openai-compat', model: 'qwen3-8b' },
            { kind: 'http', name: 'llm.judge', url: llm.url, api: 'openai-compat', model: 'big-32b' },
          ],
          stt: [{ kind: 'http', name: 'whisper-box', url: stt.url, api: 'openai-compat', model: 'whisper-large-v3' }],
        },
      }),
    })
    for (const key of ['distill.enabled', 'distill.transcribe', 'distill.moments', 'distill.fields', 'distill.judge']) await enableFlag(base, key)

    // FRESH-INSTALL STATE FIRST: before anything is captured, the served page explains itself — no blank.
    const before = await (await fetch(`${base}/settings/trace`)).text()
    assert.match(before, /Nothing to trace yet/)
    assert.match(before, /Start a session and speak/)

    const started = (await (await fetch(`${base}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'default', modeId: 'mode-meeting', title: 'trace e2e' }),
    })).json()) as Session
    // Two audio chunks spanning >15s so the distill cadence releases mid-session (the Try-it VOICE shape).
    const base0 = new Date('2026-07-13T14:00:00Z').getTime()
    const mkChunk = (seq: number, sec: number): CaptureChunk => ({
      id: `trace-audio-${seq}`, sessionId: started.id, workspaceId: 'default', source: 'mic', sequence: seq,
      capturedAt: new Date(base0 + sec * 1000).toISOString(), contentType: 'audio/webm', encoding: 'base64',
      data: Buffer.from('fake-webm-bytes').toString('base64'),
    })
    for (const c of [mkChunk(0, 0), mkChunk(1, 20)]) {
      await fetch(`${base}/capture/mic`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) })
    }

    // ---- 1) the picker fills from the REAL drain: per-segment STT provenance records (the trace root) ----
    let inputIds: string[] = []
    await eventually(async () => {
      const html = await (await fetch(`${base}/settings/trace`)).text()
      inputIds = [...html.matchAll(/href="\/settings\/trace\?input=([^"]+)"/g)].map((m) => m[1]!)
      assert.ok(inputIds.length >= 2, `expected both utterance inputs on the page, saw ${inputIds.length}`)
      assert.match(html, /Microphone · [\d,]+ characters heard/)
      assert.match(html, /whisper-box/)
    })

    // ---- 2) follow the link the page itself serves — the full hop chain, as a browser would read it ----
    await eventually(async () => {
      const html = await (await fetch(`${base}/settings/trace?input=${inputIds[inputIds.length - 1]}`)).text()
      assert.match(html, /Heard · Microphone/, 'the root hop: what was heard, on which stream')
      assert.match(html, /transcribed by whisper-box · whisper-large-v3/, 'STT provenance persisted per segment (#116)')
      assert.match(html, /Summarized/, 'the distill hop')
      assert.match(html, /they agreed to ship Thursday\./, 'the summary the fake model produced')
      assert.match(html, /Noted a commitment/, 'the moment hop')
      assert.match(html, /ship Thursday/, 'the moment text')
      assert.match(html, /Field “topic” updated · provisional/, 'the original fast-field producer row remains visible')
      assert.match(html, /Judge confirmed it/, 'the judge hop on the same trail')
      assert.match(html, /big-32b/, 'the judge lane is named')
      assert.match(html, /device-local/, 'the egress consent decision renders on the hop (#64)')
      assert.match(html, /not applicable · device-local/, 'no fabricated guard verdict for a device-local hop — the honest absence (#63/#206)')
    }, 15_000)

    // A later fast pass reuses the deterministic field document id. Advance that projection with unrelated
    // material, then walk the OLD input again: the route must read causal history, retain the original
    // producer plus its judge revision, and keep that old field/judge chain.
    const values = new FieldValueStore(app.store)
    const current = values.list('default', started.id).find((value) => value.fieldId === 'field-topic')
    assert.ok(current?.provenance.judge, 'the driven pass produced a judged field before history advances')
    const laterProvenance = { ...current.provenance, sourceChunks: ['later-unrelated-chunk'] }
    delete laterProvenance.judge
    values.put({
      ...current,
      value: 'later unrelated projection',
      state: 'provisional',
      spanId: 'later-field-pass',
      provenance: laterProvenance,
      updatedAt: '2026-07-13T15:00:00.000Z',
    })
    const oldInputHtml = await (await fetch(`${base}/settings/trace?input=${inputIds[inputIds.length - 1]}`)).text()
    assert.match(oldInputHtml, /Field “topic” updated · provisional/, 'older input keeps its original fast-field producer row')
    assert.match(oldInputHtml, /Judge confirmed it/, 'the same-pass judge revision remains ordered after its producer')
    assert.doesNotMatch(oldInputHtml, /later unrelated projection/, 'a newer pass with another source chunk does not leak into this trail')

    // ---- 3) the Audit ledger keeps the flat "all passes" view AND now carries the multi-hop rows ----
    const ledger = await (await fetch(`${base}/settings/ledger`)).text()
    assert.match(ledger, /distill/, 'the flat distill pass row is still there')
    assert.match(ledger, /moments(<| )/, 'the moments hop rides the distill pass')
    assert.match(ledger, /topic · confirmed/, 'the field pass row with its judged state')
    assert.match(ledger, /judge(<| )/, 'the judge hop rides the field pass')

    // ---- 4) sabotage: an unknown input id renders honest text, with the picker still usable ----
    const unknown = await (await fetch(`${base}/settings/trace?input=never-recorded`)).text()
    assert.match(unknown, /That input isn’t in the recorded trail/)
    assert.match(unknown, /Pick an input/)

    // ---- 5) sabotage: a corrupted record store surfaces the TRUE reason as visible text, never a blank ----
    const db = new Database(join(dir, 'default.db'))
    db.prepare("insert or replace into distillates (id, session_id, created_at, body) values ('bad', 'ses-x', '2026-07-13T14:99:00Z', '{not json')").run()
    db.close()
    const broken = await (await fetch(`${base}/settings/trace`)).text()
    assert.match(broken, /Trace unavailable/)
    assert.match(broken, /The recorded trail can’t be read right now/)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
    await new Promise<void>((resolve) => llm.server.close(() => resolve()))
    await new Promise<void>((resolve) => stt.server.close(() => resolve()))
  }
})
