import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk, Distillate, Fabric } from '@openinfo/contracts'
import { FabricDocuments, defaultFabric, invokeStt, type TranscriptSegment } from '../fabric/index.js'
import { CaptureQueue } from '../queue/spool.js'
import { WorkspaceRegistry } from '../store/index.js'
import { VoiceDocuments } from '../voice/index.js'
import { Distiller } from './distiller.js'
import { DistillDocuments } from './documents.js'
import { captureLaneLabel, speakerLabel, transcribeChunks, isAudioChunk, type SttInvoke } from './transcribe.js'

const b64 = (s: string): string => Buffer.from(s).toString('base64')

const audioChunk = (id: string, source: CaptureChunk['source'], sec: number): CaptureChunk => ({
  id,
  sessionId: 'ses-stt',
  workspaceId: 'ws-stt',
  source,
  sequence: sec,
  capturedAt: new Date(Date.UTC(2026, 6, 7, 14, 0, sec)).toISOString(),
  contentType: 'audio/wav',
  encoding: 'base64',
  data: b64('opaque audio bytes'),
})

const screenChunk: CaptureChunk = {
  id: 'scr-1', sessionId: 'ses-stt', workspaceId: 'ws-stt', source: 'screen', sequence: 9,
  capturedAt: '2026-07-07T14:00:09Z', contentType: 'image/png', encoding: 'base64', data: b64('PNGDATA'),
}

const textChunk: CaptureChunk = {
  id: 'txt-1', sessionId: 'ses-stt', workspaceId: 'ws-stt', source: 'mic', sequence: 8,
  capturedAt: '2026-07-07T14:00:08Z', contentType: 'text/plain', encoding: 'utf8', data: 'already text',
}

const fakeStt = (text: string): SttInvoke => async () => ({ text, endpoint: 'fake-stt', slot: 'stt' })

// ---- unit: the transformation, with an injected fake stt (no server) ----

test('isAudioChunk / captureLaneLabel classify physical sources without inventing identity', () => {
  assert.equal(isAudioChunk(audioChunk('a', 'mic', 0)), true)
  assert.equal(isAudioChunk(screenChunk), false) // base64 but image/* — not audio
  assert.equal(isAudioChunk(textChunk), false) // utf8 already
  assert.equal(captureLaneLabel('mic'), 'microphone')
  assert.equal(captureLaneLabel('system-audio'), 'system audio')
  assert.equal(captureLaneLabel('screen'), undefined)
  assert.equal(speakerLabel('mic'), 'microphone', 'legacy import alias has the same physical-lane semantics')
})

test('transcribeChunks rewrites audio → utf8 text, preserving source', async () => {
  const out = await transcribeChunks([audioChunk('a', 'system-audio', 0)], { invoke: fakeStt('agreed, ship Thursday') })
  assert.equal(out.length, 1)
  assert.equal(out[0]!.encoding, 'utf8')
  assert.equal(out[0]!.contentType, 'text/plain')
  assert.equal(out[0]!.data, 'agreed, ship Thursday')
  assert.equal(out[0]!.source, 'system-audio') // physical source lane is preserved
  assert.equal(out[0]!.id, 'a')
})

test('transcribeChunks stamps the real completion boundary and passes the original capture id through', async () => {
  const seen: { id: string; processedAt: string }[] = []
  const processedAt = '2026-07-07T14:00:01.250Z'
  await transcribeChunks([audioChunk('mic-source-42', 'mic', 0)], {
    invoke: fakeStt('same words'),
    now: () => processedAt,
    onTranscribed: (chunk, _text, at) => seen.push({ id: chunk.id, processedAt: at }),
  })
  assert.deepEqual(seen, [{ id: 'mic-source-42', processedAt }])
})

test('transcribeChunks drops silence (empty transcript) as a normal outcome', async () => {
  const out = await transcribeChunks([audioChunk('a', 'mic', 0)], { invoke: fakeStt('   ') })
  assert.deepEqual(out, [])
})

test('transcribeChunks passes non-audio through untouched (screen frames, existing text)', async () => {
  let called = 0
  const invoke: SttInvoke = async () => {
    called += 1
    return { text: 'should not be called', endpoint: 'fake-stt', slot: 'stt' }
  }
  const out = await transcribeChunks([screenChunk, textChunk], { invoke })
  assert.equal(called, 0) // stt never invoked for non-audio
  assert.deepEqual(out, [screenChunk, textChunk])
})

test('transcribeChunks propagates transport failure (so the drain re-queues)', async () => {
  const invoke: SttInvoke = async () => {
    throw new Error('stt endpoint down')
  }
  await assert.rejects(() => transcribeChunks([audioChunk('a', 'mic', 0)], { invoke }), /stt endpoint down/)
})

// ---- silence filter (#69): no-speech/hallucinated segments never enter the accumulator ----

/** A fake stt returning a verbose result with per-segment no_speech_prob (whisper-class shape). */
const fakeSttSegments = (text: string, segments: TranscriptSegment[]): SttInvoke => async () => ({
  text,
  segments,
  endpoint: 'fake-stt',
  slot: 'stt',
})

test('silence fixture: a window whose segments are all no-speech contributes NOTHING (no chunk, no event)', async () => {
  let transcribed = 0
  const skips: { dropped: number; total: number; windowSkipped: boolean }[] = []
  const out = await transcribeChunks([audioChunk('a', 'mic', 0)], {
    invoke: fakeSttSegments(' Thank you. Bye.', [
      { text: ' Thank you.', noSpeechProb: 0.96 },
      { text: ' Bye.', noSpeechProb: 0.99 },
    ]),
    onTranscribed: () => {
      transcribed += 1
    },
    onSilenceSkipped: (_chunk, info) => skips.push(info),
  })
  assert.deepEqual(out, []) // zero accumulated text
  assert.equal(transcribed, 0) // NO transcript.updated feed for a hallucinated window
  assert.deepEqual(skips, [{ dropped: 2, total: 2, windowSkipped: true }]) // accounted, not vanished
})

test('speech fixture is UNAFFECTED: low no_speech_prob segments pass through, transcript emitted', async () => {
  let transcribed = ''
  let skipped = 0
  const out = await transcribeChunks([audioChunk('a', 'system-audio', 0)], {
    invoke: fakeSttSegments(' We should ship Thursday.', [{ text: ' We should ship Thursday.', noSpeechProb: 0.03 }]),
    onTranscribed: (_chunk, text) => {
      transcribed = text
    },
    onSilenceSkipped: () => {
      skipped += 1
    },
  })
  assert.equal(out.length, 1)
  assert.equal(out[0]!.data, 'We should ship Thursday.')
  assert.equal(transcribed, 'We should ship Thursday.')
  assert.equal(skipped, 0)
})

test('partial filter: a hallucinated tail segment is dropped, the real speech survives', async () => {
  const skips: { windowSkipped: boolean }[] = []
  const out = await transcribeChunks([audioChunk('a', 'mic', 0)], {
    invoke: fakeSttSegments(' We ship Thursday. Thank you.', [
      { text: ' We ship Thursday.', noSpeechProb: 0.04 },
      { text: ' Thank you.', noSpeechProb: 0.98 },
    ]),
    onSilenceSkipped: (_chunk, info) => skips.push({ windowSkipped: info.windowSkipped }),
  })
  assert.equal(out.length, 1)
  assert.equal(out[0]!.data, 'We ship Thursday.') // only the speech survives
  assert.deepEqual(skips, [{ windowSkipped: false }]) // dropped a segment, but the window was not skipped
})

test('threshold is configurable: a stricter bar drops a mid-confidence segment a lenient bar keeps', async () => {
  const seg: TranscriptSegment[] = [{ text: ' maybe words', noSpeechProb: 0.7 }]
  const strict = await transcribeChunks([audioChunk('a', 'mic', 0)], { invoke: fakeSttSegments(' maybe words', seg), noSpeechThreshold: 0.6 })
  assert.deepEqual(strict, []) // 0.7 ≥ 0.6 ⇒ dropped as silence
  const lenient = await transcribeChunks([audioChunk('a', 'mic', 0)], { invoke: fakeSttSegments(' maybe words', seg), noSpeechThreshold: 0.9 })
  assert.equal(lenient.length, 1) // 0.7 < 0.9 ⇒ kept
  assert.equal(lenient[0]!.data, 'maybe words')
})

// ---- e2e: fake stt + fake llm chained through the real queue drain processor ----

const startFakeStt = async (transcripts: string[]): Promise<{ server: Server; url: string }> => {
  let i = 0
  const server = createServer((req, res) => {
    req.on('data', () => undefined)
    req.on('end', () => {
      const text = transcripts[i++] ?? ''
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ text }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, url: `http://127.0.0.1:${address.port}` }
}

const startFakeLlm = async (): Promise<{ server: Server; url: string; prompts: string[] }> => {
  const prompts: string[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: { content: string }[] }
      prompts.push(body.messages[0]!.content)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'SUMMARY: shipping Thursday.' } }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, url: `http://127.0.0.1:${address.port}`, prompts }
}

const stopServer = (s: Server): Promise<void> => new Promise((resolve) => s.close(() => resolve()))

interface Harness {
  dir: string
  store: WorkspaceRegistry
  fabric: FabricDocuments
  queue: CaptureQueue
  published: Distillate[]
}

const makeHarness = async (sttUrl: string | undefined, llmUrl: string, transcribeOn: boolean): Promise<Harness> => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-stt-'))
  const store = new WorkspaceRegistry(dir)
  const voice = new VoiceDocuments(store)
  voice.ensureDefaults()
  const docs = new DistillDocuments(store)
  docs.ensureDefaults()
  const fabric = new FabricDocuments(store)
  const doc: Fabric = {
    slots: {
      ...defaultFabric().slots,
      llm: [{ kind: 'http', name: 'llm.fast', url: llmUrl, api: 'openai-compat', model: 'llama-3.2-3b' }],
      ...(sttUrl !== undefined ? { stt: [{ kind: 'http' as const, name: 'stt-box', url: sttUrl, api: 'openai-compat' as const, model: 'parakeet-110m' }] } : {}),
    },
  }
  fabric.save(doc)
  const published: Distillate[] = []
  const distiller = new Distiller({ store, voice, fabric, docs, publish: (d) => {
    published.push(d)
  } })
  // The real drain processor shape from http.ts: transcribe (gated) then distill.
  const queue = new CaptureQueue(join(dir, 'queue'), async (chunks) => {
    const ready = transcribeOn
      ? await transcribeChunks(chunks, { invoke: (audio, opts) => invokeStt(fabric.load(), audio, opts) })
      : chunks
    await distiller.distillChunks(ready)
  })
  return { dir, store, fabric, queue, published }
}

test('e2e: audio chunks → transcribe (stt) → distill (llm), with physical-lane tagging in the prompt', async () => {
  const stt = await startFakeStt(['we should ship Thursday', 'agreed, ship Thursday'])
  const llm = await startFakeLlm()
  const h = await makeHarness(stt.url, llm.url, true)
  try {
    await h.queue.append(audioChunk('mic-1', 'mic', 0))
    await h.queue.append(audioChunk('sys-1', 'system-audio', 20))
    await h.queue.drainNow(() => undefined)

    assert.equal(h.published.length, 1) // one merge window → one distillate
    const stored = h.store.listDistillates('ws-stt', 'ses-stt')
    assert.equal(stored.length, 1)
    assert.deepEqual(stored[0]!.sourceChunks, ['mic-1', 'sys-1'])

    // physical-lane tagging is visible in the transcript that reached the llm
    const prompt = llm.prompts[0]!
    assert.match(prompt, /microphone: we should ship Thursday/)
    assert.match(prompt, /system audio: agreed, ship Thursday/)
    assert.doesNotMatch(prompt, /\bme:|\bthem:/)
    assert.equal((await h.queue.status()).pendingFiles, 0) // drained after success
  } finally {
    h.store.close()
    await rm(h.dir, { recursive: true, force: true })
    await stopServer(stt.server)
    await stopServer(llm.server)
  }
})

test('e2e: a transcription transport failure re-queues the spool file (retry-at-idle, nothing lost)', async () => {
  const llm = await startFakeLlm()
  // stt points at a dead port → invokeStt throws (connection refused) → processor throws → re-queue
  const h = await makeHarness('http://127.0.0.1:1', llm.url, true)
  try {
    await h.queue.append(audioChunk('mic-1', 'mic', 0))
    await h.queue.drainNow(() => undefined)
    assert.equal((await h.queue.status()).pendingFiles, 1) // file returned to pending
    assert.equal(h.published.length, 0) // nothing distilled (the workspace was never even created)
    assert.equal(h.store.all().some((ws) => ws.id === 'ws-stt'), false)
  } finally {
    h.store.close()
    await rm(h.dir, { recursive: true, force: true })
    await stopServer(llm.server)
  }
})

test('e2e: flag off (no transcribe stage) = current behavior — audio dropped by the utf8 filter', async () => {
  const llm = await startFakeLlm()
  const h = await makeHarness(undefined, llm.url, false) // transcribeOn = false
  try {
    await h.queue.append(audioChunk('mic-1', 'mic', 0))
    await h.queue.drainNow(() => undefined)
    // no transcription → the distiller's isText filter drops the base64 audio → no distillate, no llm call
    assert.equal(h.published.length, 0)
    assert.equal(h.store.all().some((ws) => ws.id === 'ws-stt'), false)
    assert.equal(llm.prompts.length, 0)
    assert.equal((await h.queue.status()).pendingFiles, 0) // still GC'd (successful no-text drain)
  } finally {
    h.store.close()
    await rm(h.dir, { recursive: true, force: true })
    await stopServer(llm.server)
  }
})
