import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type {
  CaptureChunk,
  OcrResult,
  SenseLaneSnapshot,
  SenseLaneSnapshotSet,
  Session,
  TranscriptUpdate,
} from '@openinfo/contracts'
import {
  createSecureTestEngineApp,
  secureTestFetch as fetch,
  testWsProtocols,
} from './test-control-plane.js'
import { WorkspaceRegistry } from '../store/index.js'

const eventually = async (assertion: () => void, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      assertion()
      return
    } catch (error) {
      last = error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  throw last
}

test('authenticated live-sense route + WS preserve three metadata-only physical lanes end to end', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-sense-lanes-'))
  const persisted: Session = {
    id: 'persisted-cold-session',
    workspaceId: 'default',
    modeId: 'mode-meeting',
    startedAt: '2026-07-13T08:00:00.000Z',
    attribution: { evidence: [], confidence: 1 },
  }
  const seedStore = new WorkspaceRegistry(dir)
  seedStore.saveSession(persisted)
  seedStore.close()

  // Reopen the engine over an unended persisted session. Consent is launch-scoped: until a fresh
  // lifecycle event arrives, the live read model must not infer that historical capture is active.
  const app = createSecureTestEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  const address = app.server.address()
  assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  const events: Array<{ name: string; payload: Record<string, unknown> }> = []
  const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/events`, testWsProtocols())
  socket.addEventListener('message', (message) => {
    events.push(JSON.parse(String(message.data)) as { name: string; payload: Record<string, unknown> })
  })

  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new Error('event socket failed')), { once: true })
    })

    // The new read is protected by the same control-plane boundary as every non-health route.
    assert.equal((await globalThis.fetch(`${base}/senses/live`)).status, 401)

    const cold = (await (await fetch(`${base}/senses/live?session=`)).json()) as SenseLaneSnapshotSet
    assert.equal(cold.sessionId, undefined, 'an empty query value is normalized, never emitted as an invalid Id')
    assert.deepEqual(cold.lanes.map((lane) => lane.source), ['mic', 'system-audio', 'screen'])
    assert.ok(cold.lanes.every((lane) => lane.disposition === 'stopped' && lane.reason === 'no-session'))

    const started = (await (await fetch(`${base}/sessions`, {
      method: 'POST',
      body: JSON.stringify({ workspaceId: 'default', modeId: 'mode-meeting' }),
    })).json()) as Session
    assert.equal(typeof app.store.getSession('default', persisted.id)?.endedAt, 'string', 'explicit start closes the persisted prior session')

    // Runtime validation is the public boundary, not the bus generic. Even an unsafe internal cast with
    // extra raw/text-shaped fields is dropped before WS serialization.
    const unsafeEgressSentinel = 'UNSAFE_CAST_MUST_NOT_ENTER_PUBLIC_SENSE_EVENT'
    await app.bus.publish('sense.lane.updated', {
      ...app.senseLanes.snapshotSet('default', started.id).lanes[0],
      text: unsafeEgressSentinel,
      data: unsafeEgressSentinel,
    } as unknown as SenseLaneSnapshot)

    // A router action can repeat session.started as session.switched for the same new session. Replaying
    // it is a strict no-op in the lane projection; its public event is also a delivery barrier proving
    // the earlier unsafe bus payload was not merely delayed.
    await app.bus.publish('session.switched', started)
    await eventually(() => {
      assert.equal(events.filter((event) => event.name === 'session.switched').length, 1)
      assert.equal(events.filter((event) => event.name === 'sense.lane.updated').length, 3)
    })
    assert.equal(JSON.stringify(events).includes(unsafeEgressSentinel), false)

    const waiting = (await (await fetch(`${base}/senses/live`)).json()) as SenseLaneSnapshotSet
    assert.equal(waiting.sessionId, started.id)
    assert.ok(waiting.lanes.every((lane) => lane.sessionId === started.id && lane.disposition === 'waiting'))

    const micRaw = 'MIC_RAW_BYTES_MUST_NOT_ENTER_SENSE_EVENT'
    const mic: CaptureChunk = {
      id: 'mic-live-1', sessionId: started.id, workspaceId: 'default', source: 'mic', sequence: 1,
      capturedAt: '2026-07-13T12:00:01.000Z', contentType: 'audio/webm', encoding: 'base64',
      data: Buffer.from(micRaw).toString('base64'),
    }
    assert.equal((await fetch(`${base}/capture/mic`, { method: 'POST', body: JSON.stringify(mic) })).status, 200)
    let live = (await (await fetch(`${base}/senses/live`)).json()) as SenseLaneSnapshotSet
    assert.equal(live.lanes[0].disposition, 'queued')
    assert.deepEqual(live.lanes[0].latestCapture, { id: mic.id, capturedAt: mic.capturedAt })
    assert.equal(live.lanes[1].disposition, 'waiting')
    assert.equal(live.lanes[2].disposition, 'waiting')

    const transcriptSecret = 'TRANSCRIPT_TEXT_MUST_NOT_ENTER_SENSE_EVENT'
    const transcript: TranscriptUpdate = {
      sessionId: started.id,
      source: 'mic',
      text: transcriptSecret,
      sourceChunkIds: [mic.id],
      sourceSequenceRange: { start: 1, end: 1 },
      capturedAtRange: { start: mic.capturedAt, end: mic.capturedAt },
      processedAt: '2026-07-13T12:00:01.275Z',
    }
    await app.bus.publish('transcript.updated', transcript)
    await app.bus.publish('transcript.updated', transcript) // a completion retry cannot publish another lane row
    live = (await (await fetch(`${base}/senses/live`)).json()) as SenseLaneSnapshotSet
    assert.equal(live.lanes[0].disposition, 'processed')
    assert.deepEqual(live.lanes[0].latestProcessing, {
      captureId: mic.id,
      capturedAt: mic.capturedAt,
      completedAt: transcript.processedAt,
      lagMs: 275,
      basis: 'capture-to-processing-completion',
      outcome: 'processed',
    })

    // A ScreenFrameMeta companion is accepted by the generic capture transport but is not a physical
    // image observation and therefore cannot move the screen lane out of waiting.
    const meta: CaptureChunk = {
      id: 'screen-meta-1', sessionId: started.id, workspaceId: 'default', source: 'screen', sequence: 1,
      capturedAt: '2026-07-13T12:00:02.000Z', contentType: 'application/json', encoding: 'utf8',
      data: JSON.stringify({ displayId: 'main', width: 1440, height: 900 }),
    }
    assert.equal((await fetch(`${base}/capture/screen`, { method: 'POST', body: JSON.stringify(meta) })).status, 200)
    assert.equal(((await (await fetch(`${base}/senses/live`)).json()) as SenseLaneSnapshotSet).lanes[2].disposition, 'waiting')

    const screenRaw = 'SCREEN_RAW_BYTES_MUST_NOT_ENTER_SENSE_EVENT'
    const screen: CaptureChunk = {
      id: 'screen-live-1', sessionId: started.id, workspaceId: 'default', source: 'screen', sequence: 2,
      capturedAt: '2026-07-13T12:00:03.000Z', contentType: 'image/jpeg', encoding: 'base64',
      data: Buffer.from(screenRaw).toString('base64'),
    }
    assert.equal((await fetch(`${base}/capture/screen`, { method: 'POST', body: JSON.stringify(screen) })).status, 200)

    const ocrSecret = 'OCR_TEXT_MUST_NOT_ENTER_SENSE_EVENT'
    const ocr: OcrResult = {
      id: 'ocr-live-1', sessionId: started.id, workspaceId: 'default', sourceChunks: [screen.id],
      text: ocrSecret, provenance: { slot: 'ocr', endpoint: 'local-test' }, schemaVersion: 1,
      capturedAt: screen.capturedAt, createdAt: '2026-07-13T12:00:03.480Z',
    }
    await app.bus.publish('ocr.completed', ocr)
    await app.bus.publish('ocr.completed', ocr) // internal retry remains an idempotent projection update
    live = (await (await fetch(`${base}/senses/live`)).json()) as SenseLaneSnapshotSet
    assert.equal(live.lanes[2].disposition, 'processed')
    assert.equal(live.lanes[2].latestProcessing?.lagMs, 480)

    await eventually(() => {
      assert.equal(events.filter((event) => event.name === 'sense.lane.updated').length, 7)
      assert.ok(events.some((event) => event.name === 'capture.received' && event.payload['id'] === mic.id))
      assert.ok(events.some((event) => event.name === 'capture.received' && event.payload['id'] === screen.id))
    })
    assert.equal(events.some((event) => event.name === 'ocr.completed'), false, 'internal OCR results are never public events')

    const laneEvents = events.filter((event) => event.name === 'sense.lane.updated')
    const serializedLanes = JSON.stringify(laneEvents)
    for (const forbidden of [micRaw, mic.data, screenRaw, screen.data, transcriptSecret, ocrSecret, unsafeEgressSentinel]) {
      assert.equal(serializedLanes.includes(forbidden), false, `sense events never include ${forbidden}`)
    }
    for (const event of laneEvents) {
      for (const forbiddenKey of ['data', 'text', 'preview', 'hash', 'error', 'blocks']) {
        assert.equal(forbiddenKey in event.payload, false, `${forbiddenKey} is absent from public lane rows`)
      }
    }

    // Existing capture receipt safety is unchanged even while the new lane event is also emitted.
    for (const receipt of events.filter((event) => event.name === 'capture.received')) {
      assert.equal('data' in receipt.payload, false)
      assert.equal('preview' in receipt.payload, false)
      assert.equal('hash' in receipt.payload, false)
      assert.equal(typeof receipt.payload['payloadBytes'], 'number')
    }

    assert.equal((await fetch(`${base}/sessions/${encodeURIComponent(started.id)}/end`, { method: 'POST' })).status, 200)
    const stopped = (await (await fetch(`${base}/senses/live?session=${encodeURIComponent(started.id)}`)).json()) as SenseLaneSnapshotSet
    assert.ok(stopped.lanes.every((lane) => lane.disposition === 'stopped' && lane.reason === 'session-ended'))
    const current = (await (await fetch(`${base}/senses/live`)).json()) as SenseLaneSnapshotSet
    assert.ok(current.lanes.every((lane) => lane.disposition === 'stopped' && lane.reason === 'no-session'))

    // The test has exercised every public transition; its rows stay the declared metadata contract.
    assert.ok(laneEvents.every((event) => typeof (event.payload as unknown as SenseLaneSnapshot).updatedAt === 'string'))
  } finally {
    socket.close()
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})
