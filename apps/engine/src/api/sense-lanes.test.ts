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

test('#192: real gate state and capture-permission truth drive lane health end to end, without restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-sense-gate-lanes-'))
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
  const laneEvents = () => events.filter((event) => event.name === 'sense.lane.updated')
  const lanes = async (): Promise<SenseLaneSnapshotSet> =>
    (await (await fetch(`${base}/senses/live`)).json()) as SenseLaneSnapshotSet
  const putFlag = async (key: string, on: boolean): Promise<void> => {
    const response = await fetch(`${base}/flags/${key}`, {
      method: 'PUT',
      body: JSON.stringify({ key, default: on, scope: 'engine', description: 'gate-truth test' }),
    })
    assert.equal(response.status, 200, key)
  }

  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new Error('event socket failed')), { once: true })
    })

    // Cold truth is unchanged by gates: with no session the honest blocker is "no session", never a gate.
    const cold = await lanes()
    assert.ok(cold.lanes.every((lane) => lane.disposition === 'stopped' && lane.health === 'unknown' && lane.reason === 'no-session'))

    // Fresh-install defaults ship every processing flag OFF, so a live session's lanes are deliberately
    // off — and must SAY so from their first row instead of reading idle (waiting/unknown).
    const started = (await (await fetch(`${base}/sessions`, {
      method: 'POST', body: JSON.stringify({ workspaceId: 'default', modeId: 'mode-meeting' }),
    })).json()) as Session
    const disabled = await lanes()
    assert.ok(disabled.lanes.every((lane) =>
      lane.disposition === 'waiting' && lane.health === 'blocked' && lane.reason === 'disabled'))
    await eventually(() => assert.equal(laneEvents().length, 3))

    // Turning ONE audio flag on changes no lane's verdict yet (distill.transcribe still blocks first) —
    // idempotent refresh, no relabel, no event.
    await putFlag('distill.enabled', true)
    // With transcription on but an EMPTY stt slot, the audio lanes' true blocker is missing configuration.
    await putFlag('distill.transcribe', true)
    await eventually(() => assert.equal(laneEvents().length, 5))
    const configBlocked = await lanes()
    assert.deepEqual(
      configBlocked.lanes.map((lane) => [lane.source, lane.health, lane.reason]),
      [
        ['mic', 'blocked', 'configuration-blocked'],
        ['system-audio', 'blocked', 'configuration-blocked'],
        ['screen', 'blocked', 'disabled'], // screen.ocr is still the screen lane's own first blocker
      ],
    )

    // Configure the fabric: the audio lanes restore their truthful idle state WITHOUT restart.
    const fabricResponse = await fetch(`${base}/fabric`, {
      method: 'PUT',
      body: JSON.stringify({
        slots: {
          stt: [{ kind: 'http', name: 'gate-truth-stt', url: 'http://127.0.0.1:1', api: 'openai-compat' }],
          tts: [], llm: [], vlm: [], embed: [],
          ocr: [{ kind: 'http', name: 'gate-truth-ocr', url: 'http://127.0.0.1:1', api: 'paddle-serving' }],
        },
      }),
    })
    assert.equal(fabricResponse.status, 200)
    await eventually(() => assert.equal(laneEvents().length, 7))
    const audioRestored = await lanes()
    assert.deepEqual(
      audioRestored.lanes.slice(0, 2).map((lane) => [lane.disposition, lane.health, lane.reason]),
      [['waiting', 'unknown', 'awaiting-capture'], ['waiting', 'unknown', 'awaiting-capture']],
    )

    // Open the screen gate too, then deny capture permission: the lane must read blocked with the TRUE
    // OS reason — never idle, never a generic failure.
    await putFlag('screen.ocr', true)
    await eventually(() => assert.equal(laneEvents().length, 8))
    const beforeDenial = await lanes()
    const denialResponse = await fetch(`${base}/screen/observations`, {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: 'default', sessionId: started.id, outcome: 'permission-denied',
        observationId: 'attempt-denied-1', occurredAt: '2026-07-14T09:00:01.000Z',
      }),
    })
    assert.equal(denialResponse.status, 200)
    const deniedRow = (await denialResponse.json()) as SenseLaneSnapshot
    assert.deepEqual([deniedRow.disposition, deniedRow.health, deniedRow.reason], ['failed', 'blocked', 'permission-denied'])
    assert.equal(deniedRow.source, 'screen')
    if (deniedRow.source === 'screen') {
      assert.deepEqual(deniedRow.latestObservation, {
        id: 'attempt-denied-1', occurredAt: '2026-07-14T09:00:01.000Z', outcome: 'permission-denied',
      })
    }
    const afterDenial = await lanes()
    assert.deepEqual(afterDenial.lanes[0], beforeDenial.lanes[0], 'a screen denial never relabels the mic lane')
    assert.deepEqual(afterDenial.lanes[1], beforeDenial.lanes[1], 'a screen denial never relabels the system-audio lane')

    // Deliberately disable ONE lane: only that lane changes; disabling cannot relabel a neighbour.
    await putFlag('screen.ocr', false)
    const oneDisabled = await lanes()
    assert.deepEqual([oneDisabled.lanes[2].health, oneDisabled.lanes[2].reason], ['blocked', 'disabled'])
    assert.deepEqual(oneDisabled.lanes[0], beforeDenial.lanes[0])
    assert.deepEqual(oneDisabled.lanes[1], beforeDenial.lanes[1])

    // Re-enabling restores the underlying truth — the overlay masked, it never clobbered: the screen lane
    // returns to its real permission-denied state, not to an invented clean slate.
    await putFlag('screen.ocr', true)
    const reEnabled = await lanes()
    assert.deepEqual([reEnabled.lanes[2].disposition, reEnabled.lanes[2].health, reEnabled.lanes[2].reason], ['failed', 'blocked', 'permission-denied'])

    // Exactly the deliberate transitions were published: 3 session rows + 2 configuration-blocked +
    // 2 restored audio + 1 screen clear + 1 denial + 1 disable + 1 re-enable = 11. Every public row stays
    // the closed metadata contract: no content, endpoint, error-string, or fix-hint fields appeared.
    await eventually(() => assert.equal(laneEvents().length, 11))
    for (const event of laneEvents()) {
      for (const key of ['data', 'text', 'preview', 'hash', 'error', 'blocks', 'endpoint', 'fix', 'detail', 'hint', 'label']) {
        assert.equal(key in event.payload, false, `${key} is absent from public lane rows`)
      }
    }
    const serialized = JSON.stringify(laneEvents())
    for (const forbidden of ['gate-truth-stt', 'gate-truth-ocr', 'Settings', 'System Settings']) {
      assert.equal(serialized.includes(forbidden), false, `sense events never include ${forbidden}`)
    }
  } finally {
    socket.close()
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})
