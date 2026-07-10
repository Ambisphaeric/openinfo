import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk, Distillate, Fabric, Session, TranscriptUpdate } from '@openinfo/contracts'
import { createEngineApp } from './http.js'

// A fake openai-compat STT: any POST returns a fixed transcript INSTANTLY (parakeet is never the stall).
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

// A fake openai-compat LLM whose completion is PARKED behind a gate — it accepts the request (so `calls`
// counts the in-flight distill) but does not respond until release() is called. This is the injected slow
// model: a parked LLM stalls the distill track without ever answering, exactly the cold-boot worst case.
const startGatedLlm = async (): Promise<{ server: Server; url: string; calls: number; release: () => void }> => {
  const state = { calls: 0 }
  let open: () => void = () => undefined
  const gate = new Promise<void>((resolve) => { open = resolve })
  const server = createServer((req, res) => {
    state.calls += 1
    req.on('data', () => undefined)
    req.on('end', () => {
      void gate.then(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'summary: shipping thursday' } }] }))
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, url: `http://127.0.0.1:${address.port}`, get calls() { return state.calls }, release: () => open() } as { server: Server; url: string; calls: number; release: () => void }
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
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  throw lastErr
}

const setFlag = (base: string, key: string): Promise<unknown> =>
  fetch(`${base}/flags/${key}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, default: true, scope: 'engine', description: key }),
  })

interface Wired {
  base: string
  started: Session
  audio: (sequence: number, sec: number) => CaptureChunk
}

// Boot a real engine with a fast fake STT and a PARKED fake LLM, distill + transcribe on, and start a session.
const wire = async (base: string, stt: { url: string }, llm: { url: string }): Promise<Wired> => {
  const fabric = (await (await fetch(`${base}/fabric`)).json()) as Fabric
  const fabricDoc: Fabric = {
    slots: {
      ...fabric.slots,
      stt: [{ kind: 'http', name: 'stt.fast', url: stt.url, api: 'openai-compat', model: 'parakeet' }],
      llm: [{ kind: 'http', name: 'llm.slow', url: llm.url, api: 'openai-compat', model: 'lfm2' }],
    },
  }
  await fetch(`${base}/fabric`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fabricDoc) })
  await setFlag(base, 'distill.enabled')
  await setFlag(base, 'distill.transcribe')
  const started = (await (await fetch(`${base}/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: 'default', modeId: 'mode-meeting' }),
  })).json()) as Session
  const bytes = Buffer.from('fake-audio-bytes').toString('base64')
  const audio = (sequence: number, sec: number): CaptureChunk => ({
    id: `a-${sequence}`, sessionId: started.id, workspaceId: 'default', source: 'mic', sequence,
    capturedAt: new Date(Date.UTC(2026, 6, 9, 12, 0, sec)).toISOString(), contentType: 'audio/wav', encoding: 'base64', data: bytes,
  })
  return { base, started, audio }
}

const capture = (base: string, chunk: CaptureChunk): Promise<unknown> =>
  fetch(`${base}/capture/mic`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(chunk) })

const queuePending = async (base: string): Promise<number> =>
  ((await (await fetch(`${base}/queue`)).json()) as { pendingFiles: number }).pendingFiles

test('#115: STT keeps flowing while the distill track is PARKED on a slow LLM — no shared lock', async () => {
  const stt = await startFakeStt('we should ship thursday')
  const llm = await startGatedLlm()
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-split-'))
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
    const w = await wire(base, stt, llm)

    // Drive four chunks spanning 15s (the distill cadence) — sequential, each waiting for its live
    // transcript, so the fourth crosses the threshold and RELEASES a distill against the parked LLM.
    for (let i = 0; i < 4; i++) {
      const before = transcripts.length
      await capture(base, w.audio(i + 1, i * 5))
      await eventually(() => assert.ok(transcripts.length > before)) // parakeet emitted, unblocked
    }
    // The distill track is now parked mid-request: the LLM saw the call but has NOT answered.
    await eventually(() => assert.equal(llm.calls, 1))
    assert.equal(distillates.length, 0) // nothing distilled — the model is parked

    // KEY: with the distill track parked, keep capturing. Every chunk STILL yields a live transcript at
    // capture cadence — parakeet never waits on the LLM (the #115 requirement). Four more chunks, four more
    // transcript events, while distill stays parked and the audio backlog drains to zero.
    for (let i = 4; i < 8; i++) {
      const before = transcripts.length
      await capture(base, w.audio(i + 1, i * 5))
      await eventually(() => assert.ok(transcripts.length > before))
    }
    assert.equal(transcripts.length, 8) // one live update per captured chunk, none dropped
    assert.equal(distillates.length, 0) // distill still parked — proves the tracks are independent
    assert.ok(transcripts.every((u) => /ship thursday/.test(u.text)))

    // BOUNDED — the STT track drained to empty despite the parked LLM (no back-up on the audio queue), and
    // the LLM track's own backlog stays bounded (the in-flight file is claimed; new text is a single file).
    await eventually(async () => assert.equal(await queuePending(base), 0))
    assert.ok((await app.textQueue.status()).pendingFiles <= 1)

    // RECOVERY — release the parked model; the distill track completes and a distillate lands.
    llm.release()
    await eventually(() => assert.ok(distillates.length >= 1))
  } finally {
    llm.release()
    await app.close()
    await rm(dir, { recursive: true, force: true })
    await new Promise<void>((resolve) => stt.server.close(() => resolve()))
    await new Promise<void>((resolve) => llm.server.close(() => resolve()))
  }
})

test('#115 cold boot: a slow model warmup never gaps the live transcript by more than one chunk interval', async () => {
  const stt = await startFakeStt('hello from the meeting')
  const llm = await startGatedLlm() // never released: the model stays "warming up" the whole test
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-coldboot-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  const transcripts: TranscriptUpdate[] = []
  app.bus.subscribe('transcript.updated', (u) => void transcripts.push(u))
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`
    // Before any transcript, the cold-boot calendar gate is closed.
    assert.equal(app.firstTranscriptSeen(), false)
    const w = await wire(base, stt, llm)

    // Ten chunks at a 3s capture cadence (span crosses 15s, so a distill fires and PARKS on the cold model).
    // Each capture must produce its live transcript promptly — the gap between consecutive transcript events
    // is one chunk, never a stall waiting on the warming model. We drive one chunk at a time and require its
    // event within a tight bound (<< any LLM round-trip), so a regression to the coupled drain would hang here.
    for (let i = 0; i < 10; i++) {
      const before = transcripts.length
      await capture(base, w.audio(i + 1, i * 3))
      await eventually(() => assert.equal(transcripts.length, before + 1), 1500)
    }
    assert.equal(transcripts.length, 10) // never gapped: every chunk transcribed while the model warmed up
    assert.equal(app.firstTranscriptSeen(), true) // the calendar cold-boot gate has now opened
  } finally {
    llm.release()
    await app.close()
    await rm(dir, { recursive: true, force: true })
    await new Promise<void>((resolve) => stt.server.close(() => resolve()))
    await new Promise<void>((resolve) => llm.server.close(() => resolve()))
  }
})
