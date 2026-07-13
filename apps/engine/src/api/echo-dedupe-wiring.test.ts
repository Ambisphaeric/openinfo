import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk, Fabric, Session, TranscriptUpdate } from '@openinfo/contracts'
import { createSecureTestEngineApp as createEngineApp, secureTestFetch as fetch } from './test-control-plane.js'

// A fake openai-compat STT that answers each call with the NEXT queued transcript — so the system chunk,
// its mic echo twin, and the control mic chunk each transcribe to a chosen text (calls are strictly
// sequential: the test waits for each drain's STT call before capturing the next chunk).
const startQueuedStt = async (responses: string[]): Promise<{ server: Server; url: string; calls: number }> => {
  const state = { calls: 0 }
  const server = createServer((req, res) => {
    req.on('data', () => undefined)
    req.on('end', () => {
      const text = responses[state.calls] ?? 'unexpected extra call'
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

// A fake openai-compat LLM that RECORDS each request body — the persisted-stream witness: whatever the
// distill pass sees is exactly what survived the drain into the text queue / cadence accumulator.
const startRecordingLlm = async (): Promise<{ server: Server; url: string; bodies: string[] }> => {
  const bodies: string[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (d: Buffer) => { body += d.toString() })
    req.on('end', () => {
      bodies.push(body)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'summary: shipping thursday' } }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, url: `http://127.0.0.1:${address.port}`, bodies }
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

test('echo-dedupe wiring: a mic fragment duplicating the system stream is dropped from the live feed AND the distill stream; a control mic fragment passes', async () => {
  const farSide = 'we should ship the release on thursday'
  const controlMic = 'let me check my notes for the agenda'
  // Call order is capture order (awaited below): system → mic echo twin → control mic → cadence-crossing tail.
  const stt = await startQueuedStt([farSide, farSide, controlMic, 'wrapping up now everyone'])
  const llm = await startRecordingLlm()
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-echo-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  const transcripts: TranscriptUpdate[] = []
  app.bus.subscribe('transcript.updated', (u) => void transcripts.push(u))
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`
    const fabric = (await (await fetch(`${base}/fabric`)).json()) as Fabric
    const fabricDoc: Fabric = {
      slots: {
        ...fabric.slots,
        stt: [{ kind: 'http', name: 'stt.fast', url: stt.url, api: 'openai-compat', model: 'parakeet' }],
        llm: [{ kind: 'http', name: 'llm.fast', url: llm.url, api: 'openai-compat', model: 'lfm2' }],
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
    const chunk = (sequence: number, source: CaptureChunk['source'], sec: number): CaptureChunk => ({
      id: `a-${sequence}`, sessionId: started.id, workspaceId: 'default', source, sequence,
      capturedAt: new Date(Date.UTC(2026, 6, 10, 12, 0, sec)).toISOString(), contentType: 'audio/wav', encoding: 'base64', data: bytes,
    })
    const capture = async (c: CaptureChunk, expectedSttCalls: number): Promise<void> => {
      await fetch(`${base}/capture/${c.source}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) })
      // Wait for THIS chunk's drain to hit the fake STT so the queued responses stay aligned to capture
      // order (the echo twin emits no transcript event, so the STT call count is the only sync point).
      await eventually(() => assert.equal(stt.calls, expectedSttCalls))
    }

    // 1. System-audio fragment: passes AND primes the rolling buffer.
    await capture(chunk(1, 'system-audio', 0), 1)
    // 2. Mic echo twin — SAME words 1s later (speaker bleed): must be dropped by the drain.
    await capture(chunk(2, 'mic', 1), 2)
    // 3. Control mic fragment — also within ±2s of the system fragment, but different words: must pass.
    await capture(chunk(3, 'mic', 2), 3)
    // 4. Tail system fragment 20s in: crosses the 15s distill cadence so the accumulated text releases
    //    to the LLM — the recorded prompt is the witness for what reached the persisted distill stream.
    await capture(chunk(4, 'system-audio', 20), 4)

    // (b) Live fan-out: the system copy and the control mic line are published; the mic echo twin is NOT.
    await eventually(() => assert.ok(transcripts.some((u) => u.source === 'mic' && u.text.includes(controlMic))))
    assert.ok(transcripts.some((u) => u.source === 'system-audio' && u.text.includes(farSide)))
    assert.ok(!transcripts.some((u) => u.source === 'mic' && u.text.includes(farSide)))

    // (a) Persisted stream: the released distill prompt retains physical system-audio/microphone labels,
    // and the echoed words NEVER appear as a microphone line — the twin died before the text queue.
    await eventually(() => assert.ok(llm.bodies.length >= 1))
    const prompt = llm.bodies.join('\n')
    assert.ok(prompt.includes(`system audio: ${farSide}`))
    assert.ok(prompt.includes(`microphone: ${controlMic}`))
    assert.ok(!prompt.includes(`microphone: ${farSide}`))
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
    await new Promise<void>((resolve) => stt.server.close(() => resolve()))
    await new Promise<void>((resolve) => llm.server.close(() => resolve()))
  }
})
