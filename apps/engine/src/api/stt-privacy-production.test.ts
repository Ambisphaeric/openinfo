import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { CaptureChunk, Distillate, Flag, Session, TranscriptUpdate } from '@openinfo/contracts'
import { FabricDocuments, defaultFabric } from '../fabric/index.js'
import { createSecureTestEngineApp, secureTestFetch } from './test-control-plane.js'

const eventually = async (assertion: () => void, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      assertion()
      return
    } catch (error) {
      last = error
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  throw last
}

test('production STT workspace deny sends zero audio bytes hosted and persists the local winner decision', async () => {
  let localSttRequests = 0
  const upstream = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      if (req.url?.includes('/audio/transcriptions')) {
        localSttRequests += 1
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ text: 'local transcript' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'local summary' } }] }))
    })
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamAddress = upstream.address()
  assert.ok(upstreamAddress && typeof upstreamAddress === 'object')
  const localUrl = `http://127.0.0.1:${upstreamAddress.port}`
  const documentedHosted = `http://stt.egress.test:${upstreamAddress.port}`
  let hostedFetches = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (raw.startsWith(documentedHosted)) {
      hostedFetches += 1
      return originalFetch(`${localUrl}${raw.slice(documentedHosted.length)}`, init)
    }
    return originalFetch(input, init)
  }) as typeof fetch

  const dir = await mkdtemp(join(tmpdir(), 'openinfo-stt-privacy-production-'))
  const app = createSecureTestEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  try {
    const fabric = new FabricDocuments(app.store)
    fabric.save({ slots: { ...defaultFabric().slots,
      stt: [
        { kind: 'http', name: 'stt.hosted', url: documentedHosted, api: 'openai-compat', model: 'hosted-stt' },
        { kind: 'http', name: 'stt.local', url: localUrl, api: 'openai-compat', model: 'local-stt' },
      ],
      llm: [{ kind: 'http', name: 'llm.local', url: localUrl, api: 'openai-compat' }],
    } })
    for (const key of ['distill.enabled', 'distill.transcribe']) {
      const flag: Flag = { key, default: true, scope: 'engine', description: key }
      app.store.layouts.put('flag', key, flag)
    }
    app.store.setEgressPolicy('default', { deny: true })
    const session: Session = {
      id: 'ses-stt-privacy', workspaceId: 'default', modeId: 'mode-meeting', startedAt: '2026-07-14T15:00:00.000Z',
      attribution: { evidence: [{ kind: 'manual', detail: 'privacy seam', weight: 1 }], confidence: 1 },
    }
    app.store.saveSession(session)
    const rawAudioSentinel = Buffer.from('PRIVATE_AUDIO_BYTES').toString('base64')
    const chunk: CaptureChunk = {
      id: 'mic-stt-privacy-1', sessionId: session.id, workspaceId: 'default', source: 'mic', sequence: 1,
      capturedAt: '2026-07-14T15:00:01.000Z', contentType: 'audio/wav', encoding: 'base64', data: rawAudioSentinel,
    }
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const response = await secureTestFetch(`http://127.0.0.1:${address.port}/capture/mic`, {
      method: 'POST', body: JSON.stringify(chunk),
    })
    assert.equal(response.status, 200)

    await eventually(() => assert.equal(app.store.listSttSegments('default', session.id).length, 1))
    const segment = app.store.listSttSegments('default', session.id)[0]!
    assert.equal(hostedFetches, 0)
    assert.equal(localSttRequests, 1)
    assert.equal(segment.provenance.endpoint, 'stt.local')
    assert.equal(segment.provenance.model, 'local-stt')
    assert.equal(segment.provenance.egress?.destination, 'device-local')
    assert.equal(segment.provenance.egress?.allowed, false)
    assert.equal(segment.provenance.egress?.decidedBy, 'workspace')
    assert.ok(!JSON.stringify(segment).includes(rawAudioSentinel))
  } finally {
    await app.close()
    globalThis.fetch = originalFetch
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})

test('mixed STT batch checkpoints text and silence before a held sibling so retry resends neither', async () => {
  let sttRequests = 0
  const llmPrompts: string[] = []
  const upstream = createServer((req, res) => {
    const body: Buffer[] = []
    req.on('data', (chunk: Buffer) => body.push(chunk))
    req.on('end', () => {
      if (req.url?.includes('/audio/transcriptions')) {
        sttRequests += 1
        if (sttRequests === 1) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ text: 'SUCCESSFUL_TRANSCRIPT_ONCE' }))
        } else if (sttRequests === 2) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ text: '' }))
        } else {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'injected boundary failure' }))
        }
        return
      }
      const parsed = JSON.parse(Buffer.concat(body).toString('utf8')) as { messages?: { content?: string }[] }
      llmPrompts.push(parsed.messages?.[0]?.content ?? '')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'mixed-batch summary' } }] }))
    })
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamAddress = upstream.address()
  assert.ok(upstreamAddress && typeof upstreamAddress === 'object')
  const localUrl = `http://127.0.0.1:${upstreamAddress.port}`
  const documentedHosted = `http://stt.mixed-boundary.test:${upstreamAddress.port}`
  const originalFetch = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return raw.startsWith(documentedHosted)
      ? originalFetch(`${localUrl}${raw.slice(documentedHosted.length)}`, init)
      : originalFetch(input, init)
  }) as typeof fetch

  const dir = await mkdtemp(join(tmpdir(), 'openinfo-stt-mixed-terminal-'))
  const app = createSecureTestEngineApp({ dataRoot: dir, log: () => undefined })
  const transcripts: TranscriptUpdate[] = []
  const distillates: Distillate[] = []
  app.bus.subscribe('transcript.updated', (update) => void transcripts.push(update))
  app.bus.subscribe('distillate.updated', (distillate) => void distillates.push(distillate))
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  try {
    new FabricDocuments(app.store).save({
      slots: {
        ...defaultFabric().slots,
        stt: [{ kind: 'http', name: 'stt.hosted-mixed', url: documentedHosted, api: 'openai-compat', model: 'hosted-stt' }],
        llm: [{ kind: 'http', name: 'llm.local', url: localUrl, api: 'openai-compat' }],
      },
    })
    for (const key of ['distill.enabled', 'distill.transcribe']) {
      app.store.layouts.put<Flag>('flag', key, { key, default: true, scope: 'engine', description: key })
    }
    const session: Session = {
      id: 'ses-stt-mixed', workspaceId: 'default', modeId: 'mode-meeting', startedAt: '2026-07-14T15:10:00.000Z',
      attribution: { evidence: [{ kind: 'manual', detail: 'mixed terminal retry', weight: 1 }], confidence: 1 },
    }
    app.store.saveSession(session)
    const audio = (id: string, sequence: number, seconds: number): CaptureChunk => ({
      id, sessionId: session.id, workspaceId: 'default', source: 'mic', sequence,
      capturedAt: new Date(Date.UTC(2026, 6, 14, 15, 10, seconds)).toISOString(),
      contentType: 'audio/wav', encoding: 'base64', data: Buffer.from(`PRIVATE_${id}`).toString('base64'),
    })
    const textTail: CaptureChunk = {
      id: 'mixed-text-tail', sessionId: session.id, workspaceId: 'default', source: 'mic', sequence: 4,
      capturedAt: '2026-07-14T15:10:20.000Z', contentType: 'text/plain', encoding: 'utf8', data: 'TAIL_FOR_CADENCE',
    }
    for (const chunk of [
      audio('mixed-text-success', 1, 0),
      audio('mixed-silence-success', 2, 5),
      audio('mixed-held', 3, 10),
      textTail,
    ]) await app.captureQueue.append(chunk)

    await app.captureQueue.drainNow(() => undefined)
    assert.equal((await app.captureQueue.status()).pendingFiles, 1, 'held sibling requeues the raw file once')
    assert.equal((await app.captureQueue.status()).lastFailure?.class, 'guard-held')
    assert.equal(sttRequests, 3)
    assert.equal(app.store.listSttSegments('default', session.id).length, 2, 'text and silence checkpointed')
    assert.equal(transcripts.filter((update) => update.text.includes('SUCCESSFUL_TRANSCRIPT_ONCE')).length, 1)
    assert.equal(app.guardHolds.list('default').filter((hold) => hold.stage === 'stt').length, 1)

    await app.captureQueue.drainNow(() => undefined)
    assert.equal((await app.captureQueue.status()).pendingFiles, 0, 'terminal retry consumes the raw batch')
    assert.equal(sttRequests, 3, 'completed text, completed silence, and held audio were never resent')
    await app.textQueue.drainNow(() => undefined)

    const checkpoints = app.store.listSttSegments('default', session.id)
    assert.equal(checkpoints.find((segment) => segment.chunkId === 'mixed-text-success')?.textChars, 'SUCCESSFUL_TRANSCRIPT_ONCE'.length)
    assert.equal(checkpoints.find((segment) => segment.chunkId === 'mixed-silence-success')?.textChars, 0)
    assert.equal(checkpoints.some((segment) => segment.chunkId === 'mixed-held'), false)
    assert.equal(transcripts.filter((update) => update.text.includes('SUCCESSFUL_TRANSCRIPT_ONCE')).length, 1)
    assert.equal(distillates.length, 1)
    assert.equal(distillates[0]?.sourceChunks.filter((id) => id === 'mixed-text-success').length, 1)
    assert.equal(distillates[0]?.sourceChunks.includes('mixed-held'), false)
    assert.equal(llmPrompts.length, 1)
    assert.equal((llmPrompts[0]?.match(/SUCCESSFUL_TRANSCRIPT_ONCE/g) ?? []).length, 1)
  } finally {
    await app.close()
    globalThis.fetch = originalFetch
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})
