import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk, Distillate, Fabric, Session, TranscriptUpdate } from '@openinfo/contracts'
import { createSecureTestEngineApp as createEngineApp, secureTestFetch as fetch, testWsProtocols } from './test-control-plane.js'

// A fake openai-compat STT: any POST returns a fixed transcript ({text} is all the adapter needs).
const startFakeStt = async (text: string): Promise<{ server: Server; url: string; calls: number }> => {
  const state = { calls: 0 }
  const server = createServer((req, res) => {
    req.on('data', () => undefined)
    req.on('end', () => {
      state.calls += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ text }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, url: `http://127.0.0.1:${address.port}`, get calls() { return state.calls } } as { server: Server; url: string; calls: number }
}

// A fake openai-compat LLM: returns a summary for any chat completion (the distill pass).
const startFakeLlm = async (): Promise<{ server: Server; url: string; calls: number }> => {
  const state = { calls: 0 }
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      state.calls += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'summary: shipping Thursday' } }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, url: `http://127.0.0.1:${address.port}`, get calls() { return state.calls } } as { server: Server; url: string; calls: number }
}

const eventually = async (assertion: () => void | Promise<void>, timeoutMs = 4000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown
  while (Date.now() < deadline) {
    try {
      await assertion()
      return
    } catch (err) {
      lastErr = err
      await new Promise((r) => setTimeout(r, 15))
    }
  }
  throw lastErr
}

// A minimal WS event subscriber (the served feed the HUD's transport consumes) — proves the event
// reaches a real client over the wire, not just the in-process bus (QA rule: served surfaces are driven).
const openEvents = async (base: string): Promise<{ events: { name: string; payload: unknown }[]; close: () => void }> => {
  const events: { name: string; payload: unknown }[] = []
  const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/events`, testWsProtocols())
  socket.addEventListener('message', (event) => {
    events.push(JSON.parse(String((event as { data: unknown }).data)) as { name: string; payload: unknown })
  })
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error('ws failed')), { once: true })
  })
  return { events, close: () => socket.close() }
}

const setFlag = (base: string, key: string): Promise<unknown> =>
  fetch(`${base}/flags/${key}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, default: true, scope: 'engine', description: key }),
  })

test('#58: transcribe success publishes an ephemeral transcript.updated on the bus (fast-path), and distill is throttled until session end flushes the tail', async () => {
  const stt = await startFakeStt('we should ship thursday')
  const llm = await startFakeLlm()
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-fastpath-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })

  const transcripts: TranscriptUpdate[] = []
  const distillates: Distillate[] = []
  app.bus.subscribe('transcript.updated', (u) => void transcripts.push(u))
  app.bus.subscribe('distillate.updated', (d) => void distillates.push(d))

  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    // wire fake stt + llm slots, enable distill + the transcribe pre-stage
    const fabric = (await (await fetch(`${base}/fabric`)).json()) as Fabric
    const fabricDoc: Fabric = {
      slots: {
        ...fabric.slots,
        stt: [{ kind: 'http', name: 'stt.fast', url: stt.url, api: 'openai-compat', model: 'whisper' }],
        llm: [{ kind: 'http', name: 'llm.fast', url: llm.url, api: 'openai-compat', model: 'llama-3.2-3b' }],
      },
    }
    await fetch(`${base}/fabric`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fabricDoc) })
    await setFlag(base, 'distill.enabled')
    await setFlag(base, 'distill.transcribe')

    const sub = await openEvents(base)

    const started = (await (await fetch(`${base}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'default', modeId: 'mode-meeting' }),
    })).json()) as Session

    // two SUB-threshold audio chunks (span 6s << the 15s cadence) — a base64 audio/* payload
    const audio = Buffer.from('fake-audio-bytes').toString('base64')
    const chunk = (sequence: number, sec: number): CaptureChunk => ({
      id: `a-${sequence}`, sessionId: started.id, workspaceId: 'default', source: 'mic', sequence,
      capturedAt: new Date(Date.UTC(2026, 6, 9, 12, 0, sec)).toISOString(), contentType: 'audio/wav', encoding: 'base64', data: audio,
    })
    for (const c of [chunk(1, 0), chunk(2, 6)]) {
      await fetch(`${base}/capture/mic`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) })
    }

    // FAST-PATH: the transcribe drain stage ran and published a live transcript event within one drain,
    // carrying the me-side raw text and a capturedAt range — NOT persisted anywhere.
    await eventually(() => assert.ok(transcripts.length >= 1))
    const update = transcripts[0]!
    assert.equal(update.sessionId, started.id)
    assert.equal(update.source, 'mic')
    assert.match(update.text, /ship thursday/)
    assert.ok(update.capturedAtRange.start <= update.capturedAtRange.end)

    // SERVED PROOF: the same event reached a real WS client (the feed the HUD's transport renders).
    await eventually(() => assert.ok(sub.events.some((e) => e.name === 'transcript.updated')))
    const wire = sub.events.find((e) => e.name === 'transcript.updated')!.payload as TranscriptUpdate
    assert.equal(wire.source, 'mic')
    assert.match(wire.text, /ship thursday/)
    sub.close()

    // THROTTLE: transcription ran (fast-path fired), but the sub-threshold span did NOT trigger a distill
    // LLM pass on the drain — no distillate persisted yet, and the fake llm was never called.
    assert.equal(distillates.length, 0)
    assert.deepEqual(app.store.listDistillates('default', started.id), [])
    assert.equal(llm.calls, 0)

    // SESSION-END FLUSH: ending the session distills the accumulated tail exactly once (even with no act).
    await fetch(`${base}/sessions/${encodeURIComponent(started.id)}/end`, { method: 'POST' })
    await eventually(() => assert.equal(distillates.length, 1))
    assert.equal(app.store.listDistillates('default', started.id).length, 1)
    assert.equal(llm.calls, 1) // exactly ONE distill pass for the whole session, not one-per-drain
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
    await new Promise<void>((resolve) => stt.server.close(() => resolve()))
    await new Promise<void>((resolve) => llm.server.close(() => resolve()))
  }
})
