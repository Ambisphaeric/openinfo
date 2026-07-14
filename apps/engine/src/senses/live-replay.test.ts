import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SenseLaneSnapshot as SenseLaneSnapshotSchema,
  type CaptureChunk,
  type OcrResult,
  type SenseLaneSnapshot,
  type SenseLaneSnapshotSet,
  type Session,
} from '@openinfo/contracts'
import { Value } from '@sinclair/typebox/value'
import { createFixtureReplay, loadFixtureSync, type FixtureReplay } from '../../../../tools/fixtures/model.mjs'
import { senseLaneRowsFromFixture } from '../../../../tools/fixtures/lane-rows.mjs'
import { FabricDocuments, type SttResult } from '../fabric/index.js'
import { WorkspaceRegistry } from '../store/index.js'
import { ScreenOcrProcessor } from '../screen/processor.js'
import { buildTranscriptUpdates, transcribeChunks, type TranscribedSegment } from '../distill/transcribe.js'
import { evaluateSenseGates } from '../surfaces/settings/sense-gates.js'
import { senseLaneGateState } from './gates.js'
import { SenseLaneTracker } from './live.js'

/**
 * Deterministic tri-lane replay proof (#174 slice E, acceptance criterion: "a deterministic replay fixture
 * proves all three lanes remain distinguishable end to end").
 *
 * The committed synthetic-converged fixture (#32) models exactly the three independent evidence lanes —
 * microphone→STT, system-audio→STT, screen→OCR/VLM. This test replays it through the REAL pipeline
 * components and reads the result through the REAL live-sense projection:
 *
 *   - mic/system-audio bytes → the REAL `transcribeChunks` stage (capture-scoped replay STT invoker, which
 *     verifies the request bytes against the named capture so equal bytes could never cross lanes) → the
 *     REAL `buildTranscriptUpdates` aggregation → `SenseLaneTracker.recordTranscript`;
 *   - the screen frame → the REAL `ScreenOcrProcessor` over a REAL `WorkspaceRegistry` (the same idiom
 *     screen/processor.test.ts uses; OcrResult + Distillate are actually persisted) → its `publishOcr`
 *     callback is the engine's real `ocr.completed` → `SenseLaneTracker.recordOcr` wiring (api/http.ts).
 *
 * The lanes are then read via `tracker.snapshotSet(workspace, session)`, which is BYTE-FOR-BYTE the value
 * both read paths return: `GET /senses/live` (api/http.ts getLiveSenses) and the `live-senses` `POST /query`
 * source (api/http.ts: `ctx.senseLanes.snapshotSet(workspaceId, explicitSessionId).lanes`). The HTTP/auth
 * plumbing around that projection is covered by api/live-senses-query.test.ts; here we prove the fixture →
 * real-stages → tracker → projection path itself keeps the three lanes distinguishable and honest.
 *
 * The surface half of "carried to the surface" lives in the client (which depends only on
 * @openinfo/contracts, never the engine): apps/client/src/surfaces/blocks/sense-lanes-replay.test.ts renders
 * the SAME canonical rows — `senseLaneRowsFromFixture` — through the real sanitizeSenseLaneSnapshot +
 * renderSenseLanes. This test proves those shared rows are exactly what the REAL tracker emits, so the two
 * halves meet on identical, fixture-derived truth without a cross-package import.
 */

const FIXTURE_URL = new URL('../../../../tools/fixtures/fixtures/synthetic-converged.v1.json', import.meta.url)
const FIXTURE_WORKSPACE = 'workspace-synthetic'
const FIXTURE_SESSION = 'session-synthetic'
const AUDIO = /^audio\//i
const IMAGE = /^image\//i

const fixtureSession = (): Session => ({
  id: FIXTURE_SESSION,
  workspaceId: FIXTURE_WORKSPACE,
  modeId: 'mode-replay',
  // Before the first fixture capture (13:00:00) so every lane opens under this observed launch.
  startedAt: '2026-07-12T12:59:59.000Z',
  attribution: { evidence: [], confidence: 1 },
})

const withStore = async (fn: (store: WorkspaceRegistry) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-live-replay-'))
  const store = new WorkspaceRegistry(dir)
  try {
    await fn(store)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Drive the whole fixture through the real stages into a fresh tracker. `skipMic` withholds the microphone
 * lane entirely — the mute/disable case: no data ever reaches that lane. Returns the projection every
 * read path serves plus the captured OcrResult for provenance assertions.
 */
const driveTriLane = async (
  store: WorkspaceRegistry,
  replay: FixtureReplay,
  options: { skipMic?: boolean } = {},
): Promise<{ tracker: SenseLaneTracker; snapshot: SenseLaneSnapshotSet; ocr: OcrResult }> => {
  const tracker = new SenseLaneTracker({ now: replay.now })
  tracker.startSession(fixtureSession())

  // --- audio lanes: real transcribe stage (capture-scoped STT) → real aggregation → tracker ---
  const audioSources = (options.skipMic ? ['system-audio'] : ['mic', 'system-audio']) as ('mic' | 'system-audio')[]
  const segments: TranscribedSegment[] = []
  for (const source of audioSources) {
    const capture = replay.captures(source)[0] as unknown as CaptureChunk
    tracker.recordCapture(capture)
    await transcribeChunks([capture], {
      invoke: async (audio) => (await replay.invokeSttFor(capture.id, audio)) as SttResult,
      now: () => replay.now().toISOString(),
      onTranscribed: (chunk, text, processedAt) => segments.push({
        sourceChunkId: chunk.id,
        sessionId: chunk.sessionId,
        source: chunk.source,
        sequence: chunk.sequence,
        text,
        capturedAt: chunk.capturedAt,
        processedAt,
      }),
    })
  }
  for (const update of buildTranscriptUpdates(segments)) tracker.recordTranscript(update)

  // --- screen lane: real ScreenOcrProcessor + real storage → real ocr.completed → tracker ---
  const screenImage = replay.captures('screen').find((chunk) => IMAGE.test(chunk.contentType)) as unknown as CaptureChunk
  tracker.recordCapture(screenImage)
  let ocr: OcrResult | undefined
  const processor = new ScreenOcrProcessor({
    store,
    fabric: new FabricDocuments(store),
    isEnabled: () => true,
    // Capture-scoped OCR invoker: identical bytes in another lane/frame could not cross provenance.
    invoke: (params) => replay.invokeOcrFor(screenImage.id, params),
    publishOcr: (result) => {
      ocr = result
      tracker.recordOcr(result) // the exact api/http.ts `bus.subscribe('ocr.completed', … recordOcr)` wiring
    },
    reportProcessingOutcome: () => assert.fail('a processed frame is signalled only through ocr.completed'),
    now: replay.now,
    newId: replay.newId,
  })
  await processor.process(screenImage)
  assert.ok(ocr, 'the real screen processor published an OcrResult')

  return { tracker, snapshot: tracker.snapshotSet(FIXTURE_WORKSPACE, FIXTURE_SESSION), ocr }
}

test('tri-lane fixture replays through the real stages into three distinguishable, correctly-attributed lanes', async () => {
  await withStore(async (store) => {
    const fixture = loadFixtureSync(FIXTURE_URL)
    const { snapshot, ocr } = await driveTriLane(store, createFixtureReplay(fixture))

    // Three simultaneous lanes, canonical mic → system-audio → screen order.
    assert.deepEqual(snapshot.lanes.map((lane) => lane.source), ['mic', 'system-audio', 'screen'])
    const [mic, system, screen] = snapshot.lanes as [SenseLaneSnapshot, SenseLaneSnapshot, SenseLaneSnapshot]

    // Each lane correlates to ITS OWN replayed capture id — exact equality, not mere presence.
    assert.equal(mic.disposition, 'processed')
    assert.equal(mic.latestCapture?.id, 'cap-mic-0001')
    assert.equal(mic.latestProcessing?.captureId, 'cap-mic-0001')
    assert.equal(mic.latestProcessing?.lagMs, 3_000)

    assert.equal(system.disposition, 'processed')
    assert.equal(system.latestCapture?.id, 'cap-system-0001')
    assert.equal(system.latestProcessing?.captureId, 'cap-system-0001')
    assert.equal(system.latestProcessing?.lagMs, 2_000)

    // Screen outcome truth is preserved: the fixture's OCR found text, so the lane reads processed, and the
    // real OcrResult that drove it names the screen image frame exactly (not the audio captures).
    assert.equal(screen.disposition, 'processed')
    assert.equal(screen.latestCapture?.id, 'cap-screen-image-0001')
    assert.equal(screen.latestProcessing?.captureId, 'cap-screen-image-0001')
    assert.equal(screen.latestProcessing?.lagMs, 1_000)
    assert.deepEqual(ocr.sourceChunks, ['cap-screen-image-0001'])

    // Microphone and system audio never merge or swap attribution: distinct captures, distinct evidence.
    assert.notEqual(mic.latestProcessing?.captureId, system.latestProcessing?.captureId)
    assert.notEqual(mic.latestCapture?.id, system.latestCapture?.id)

    // The projection rows are exactly the closed public contract every read path serializes.
    for (const lane of snapshot.lanes) {
      assert.equal(Value.Check(SenseLaneSnapshotSchema, lane), true)
    }

    // The rows the REAL tracker emits are byte-for-byte the shared, fixture-derived canonical rows the
    // client surface test renders — the two halves of the proof meet on identical truth.
    assert.deepEqual(snapshot.lanes, senseLaneRowsFromFixture(fixture))

    // No private capture bytes, transcript/OCR text, or endpoint identity can be in the metadata read model.
    const serialized = JSON.stringify(snapshot)
    for (const forbidden of [
      'U1lOVEhFVElD', // any synthetic capture payload prefix
      'Please follow up', 'I will review', 'Pull request 150',
      'fixture-parakeet', 'fixture-ocr', '"text"', '"data"', '"endpoint"', '"blocks"',
    ]) {
      assert.equal(serialized.includes(forbidden), false, `live-sense projection leaked ${forbidden}`)
    }
  })
})

test('the tri-lane replay is byte-stable: two independent in-process runs yield identical lane truth', async () => {
  await withStore(async (storeA) => {
    await withStore(async (storeB) => {
      const fixture = loadFixtureSync(FIXTURE_URL)
      // Independent replay instances (each validates a fresh clone; cursors and the id factory start at 0).
      const runA = await driveTriLane(storeA, createFixtureReplay(fixture))
      const runB = await driveTriLane(storeB, createFixtureReplay(fixture))
      assert.deepEqual(runA.snapshot, runB.snapshot)
      assert.equal(JSON.stringify(runA.snapshot), JSON.stringify(runB.snapshot))
      // The persisted OcrResult is byte-identical too — the deterministic replay clock/id factory make the
      // whole capture→OCR→projection path reproducible, not just the in-memory read model.
      assert.deepEqual(runA.ocr, runB.ocr)
    })
  })
})

test('muting one lane cannot relabel another: the withheld lane reads honestly idle, the others keep identity', async () => {
  // Replay-level coverage of "muting or disabling one lane cannot silently relabel another lane". The
  // tracker has no per-lane disable verb; at the read-model level a muted/disabled lane is precisely one on
  // which no capture or result ever arrives. Unit/surface coverage already proves adjacent facets: engine
  // senses/live.test.ts ("screen observations never alter audio lanes"; workspace isolation), client
  // hud/sense-lane-cache.test.ts (a payload patch replaces only the matching physical source), and client
  // blocks/sense-lanes.test.ts (a missing/widened row degrades to "Status unavailable", never another
  // lane's data). This adds the end-to-end replay case.
  await withStore(async (store) => {
    const fixture = loadFixtureSync(FIXTURE_URL)
    const { tracker, snapshot } = await driveTriLane(store, createFixtureReplay(fixture), { skipMic: true })
    const [mic, system, screen] = snapshot.lanes as [SenseLaneSnapshot, SenseLaneSnapshot, SenseLaneSnapshot]

    // The withheld mic lane is honestly idle — still awaiting its first capture, carrying NONE of the
    // active lanes' identity or evidence.
    assert.equal(mic.source, 'mic')
    assert.equal(mic.disposition, 'waiting')
    assert.equal(mic.reason, 'awaiting-capture')
    assert.equal(mic.latestCapture, undefined)
    assert.equal(mic.latestProcessing, undefined)

    // The two active lanes keep their own exact attribution regardless of the muted neighbour.
    assert.equal(system.disposition, 'processed')
    assert.equal(system.latestProcessing?.captureId, 'cap-system-0001')
    assert.equal(screen.disposition, 'processed')
    assert.equal(screen.latestProcessing?.captureId, 'cap-screen-image-0001')

    // Adversarial: the mic lane cannot be completed by another lane's replayed capture id — attribution
    // crossing is rejected outright, so a mislabelled result can never relabel the idle lane.
    const crossed = tracker.recordTranscript({
      sessionId: FIXTURE_SESSION,
      source: 'mic',
      text: 'not mine',
      sourceChunkIds: ['cap-system-0001'],
      sourceSequenceRange: { start: 0, end: 0 },
      capturedAtRange: { start: '2026-07-12T13:00:01.000Z', end: '2026-07-12T13:00:01.000Z' },
      processedAt: '2026-07-12T13:00:03.000Z',
    })
    assert.equal(crossed, undefined, 'a foreign capture id cannot complete the mic lane')
    assert.equal(tracker.snapshotSet(FIXTURE_WORKSPACE, FIXTURE_SESSION).lanes[0]!.disposition, 'waiting')
  })
})

test('ending the session stops every lane honestly, relabeling none', async () => {
  await withStore(async (store) => {
    const fixture = loadFixtureSync(FIXTURE_URL)
    const { tracker } = await driveTriLane(store, createFixtureReplay(fixture))
    const stopped = tracker.endSession({ ...fixtureSession(), endedAt: '2026-07-12T13:05:00.000Z' })
    assert.deepEqual(stopped.map((lane) => lane.source), ['mic', 'system-audio', 'screen'])
    assert.ok(stopped.every((lane) => lane.disposition === 'stopped' && lane.reason === 'session-ended'))
    // A stopped lane reads honestly stopped and drops no-longer-live per-attempt provenance, never borrowing
    // another lane's disposition or evidence.
    const screen = stopped[2]!
    assert.equal(screen.source, 'screen')
    if (screen.source === 'screen') assert.equal(screen.latestObservation, undefined)
  })
})

test('#192: disabling or blocking one lane through REAL gate state cannot relabel another, and reopening restores replayed truth', async () => {
  // Extends the #174 no-relabel replay coverage for the gate-driven off states: the overlay comes from the
  // ACTUAL evaluateSenseGates chain over honest flag/fabric inputs (via senseLaneGateState), never from a
  // hand-picked reason, so gate reordering or reclassification breaks this proof, not just a unit test.
  await withStore(async (store) => {
    const fixture = loadFixtureSync(FIXTURE_URL)
    const { tracker, snapshot } = await driveTriLane(store, createFixtureReplay(fixture))
    const gateInput = (screenOcrOn: boolean) => ({
      flags: [
        { key: 'distill.enabled', default: true, scope: 'engine', description: 'replay' },
        { key: 'distill.transcribe', default: true, scope: 'engine', description: 'replay' },
        { key: 'screen.ocr', default: screenOcrOn, scope: 'engine', description: 'replay' },
      ] as const,
      fabric: {
        slots: {
          stt: [{ kind: 'http', name: 'replay-stt', url: 'http://127.0.0.1:1', api: 'openai-compat' }],
          tts: [], llm: [], vlm: [], embed: [],
          ocr: [{ kind: 'http', name: 'replay-ocr', url: 'http://127.0.0.1:1', api: 'paddle-serving' }],
        },
      },
    })

    // Every gate open: the overlay is empty and the replayed projection is untouched, byte for byte.
    assert.deepEqual(tracker.applyGates(senseLaneGateState(evaluateSenseGates(gateInput(true) as never))), [])
    assert.deepEqual(tracker.snapshotSet(FIXTURE_WORKSPACE, FIXTURE_SESSION), snapshot)

    // Turn the screen feature off — the REAL chain names screen.ocr as the blocker for exactly one lane.
    const blocked = tracker.applyGates(senseLaneGateState(evaluateSenseGates(gateInput(false) as never)))
    assert.deepEqual(blocked.map((lane) => [lane.source, lane.disposition, lane.health, lane.reason]), [
      ['screen', 'processed', 'blocked', 'disabled'],
    ])
    const gated = tracker.snapshotSet(FIXTURE_WORKSPACE, FIXTURE_SESSION)
    // The audio lanes keep their exact replayed attribution — no merge, no swap, no relabel.
    assert.deepEqual(gated.lanes[0], snapshot.lanes[0])
    assert.deepEqual(gated.lanes[1], snapshot.lanes[1])
    // The screen lane's capture/processing evidence survives the overlay untouched.
    assert.deepEqual(gated.lanes[2].latestProcessing, snapshot.lanes[2].latestProcessing)
    assert.deepEqual(gated.lanes[2].latestCapture, snapshot.lanes[2].latestCapture)

    // Re-enable: the screen lane returns to its exact replayed truth without restart (updatedAt advances —
    // the visible row genuinely changed twice).
    const restored = tracker.applyGates(senseLaneGateState(evaluateSenseGates(gateInput(true) as never)))
    assert.equal(restored.length, 1)
    const { updatedAt: _restoredAt, ...restoredRest } = restored[0]!
    const { updatedAt: _originalAt, ...originalRest } = snapshot.lanes[2]
    assert.deepEqual(restoredRest, originalRest)
    assert.deepEqual(tracker.snapshotSet(FIXTURE_WORKSPACE, FIXTURE_SESSION).lanes[0], snapshot.lanes[0])
    assert.deepEqual(tracker.snapshotSet(FIXTURE_WORKSPACE, FIXTURE_SESSION).lanes[1], snapshot.lanes[1])
  })
})

test('#192: a capture-permission denial blocks only the screen lane with its true reason, never an audio lane', async () => {
  await withStore(async (store) => {
    const fixture = loadFixtureSync(FIXTURE_URL)
    const { tracker, snapshot } = await driveTriLane(store, createFixtureReplay(fixture))

    const denied = tracker.recordScreenCaptureObservation({
      workspaceId: FIXTURE_WORKSPACE, sessionId: FIXTURE_SESSION, outcome: 'permission-denied',
      observationId: 'replay-denied-1', occurredAt: '2026-07-12T13:00:30.000Z',
    })
    assert.equal(denied?.source, 'screen')
    assert.deepEqual([denied?.disposition, denied?.health, denied?.reason], ['failed', 'blocked', 'permission-denied'])
    if (denied?.source === 'screen') {
      assert.deepEqual(denied.latestObservation, {
        id: 'replay-denied-1', occurredAt: '2026-07-12T13:00:30.000Z', outcome: 'permission-denied',
      })
    }

    const after = tracker.snapshotSet(FIXTURE_WORKSPACE, FIXTURE_SESSION)
    assert.deepEqual(after.lanes[0], snapshot.lanes[0], 'the mic lane is byte-identical after the screen denial')
    assert.deepEqual(after.lanes[1], snapshot.lanes[1], 'the system-audio lane is byte-identical after the screen denial')
    // The blocked row still validates the closed public contract and leaks nothing new.
    assert.equal(Value.Check(SenseLaneSnapshotSchema, after.lanes[2]), true)
    for (const forbidden of ['tcc', 'denied by', '"error"', '"detail"']) {
      assert.equal(JSON.stringify(after).toLowerCase().includes(forbidden), false)
    }
  })
})
