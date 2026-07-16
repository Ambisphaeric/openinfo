import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ContextPacket, EgressDecision, OcrResult, Session, SttSegment } from '@openinfo/contracts'
import { createFixtureReplay, loadFixtureSync, type FixtureReplay } from '../../../../tools/fixtures/model.mjs'
import { WorkspaceRegistry } from '../store/index.js'
import { buildContextPackets } from './packets.js'

/**
 * #176 determinism proof over the #32 record/replay harness: the SAME fixture, replayed twice into the
 * REAL store + builder path, yields byte-identical ContextPackets — and a rebuild over an already-built
 * store appends nothing (idempotence). No model, microphone, screen API, or network is touched.
 */

const WS = 'workspace-synthetic'
const SES = 'session-synthetic'

interface FixtureSttOutput {
  slot: 'stt'
  text: string
  endpoint: string
  model?: string
}

/**
 * Drive the fixture's three lanes through the stored-record shapes the runtime persists (SttSegment per
 * transcribed audio chunk, OcrResult per understood frame), using the replay's deterministic clock/id
 * factories — the same seams the drain and screen processor use.
 */
const persistObservations = async (store: WorkspaceRegistry, replay: FixtureReplay): Promise<void> => {
  for (const lane of ['mic', 'system-audio'] as const) {
    for (const chunk of replay.captures(lane)) {
      const output = (await replay.invokeSttFor(chunk.id, { base64: chunk.data, contentType: chunk.contentType })) as FixtureSttOutput
      const at = replay.now().toISOString()
      const segment: SttSegment = {
        id: replay.newId(),
        workspaceId: chunk.workspaceId,
        sessionId: chunk.sessionId,
        chunkId: chunk.id,
        source: lane,
        capturedAt: chunk.capturedAt,
        processedAt: at,
        textChars: output.text.length,
        provenance: { slot: 'stt', endpoint: output.endpoint, ...(output.model !== undefined ? { model: output.model } : {}) },
        schemaVersion: 1,
        createdAt: at,
      }
      store.saveSttSegment(segment)
    }
  }
  const frame = replay.captures('screen').find((chunk) => chunk.contentType === 'image/jpeg')
  assert.ok(frame, 'synthetic fixture has a screen image')
  const seen = await replay.invokeOcrFor(frame.id, { image: frame.data, contentType: frame.contentType })
  const at = replay.now().toISOString()
  const ocr: OcrResult = {
    id: replay.newId(),
    sessionId: frame.sessionId,
    workspaceId: frame.workspaceId,
    sourceChunks: [frame.id],
    text: seen.text,
    ...(seen.blocks !== undefined ? { blocks: seen.blocks } : {}),
    provenance: {
      slot: seen.slot,
      endpoint: seen.endpoint,
      ...(seen.model !== undefined ? { model: seen.model } : {}),
      ...(seen.usage !== undefined ? { usage: seen.usage } : {}),
      ...(seen.egress !== undefined ? { egress: seen.egress as EgressDecision } : {}),
    },
    schemaVersion: 1,
    createdAt: at,
    capturedAt: frame.capturedAt,
  }
  store.saveOcrResult(ocr)
}

const fixtureSession = (): Session => ({
  id: SES,
  workspaceId: WS,
  modeId: 'mode-meeting',
  startedAt: '2026-07-12T13:00:00.000Z',
  attribution: { evidence: [{ kind: 'window', detail: 'app: Fixture', weight: 0.5 }], confidence: 1 },
})

/** One full record-shaped replay + build into a fresh store; returns the persisted packets. */
const replayAndBuild = async (dir: string, replay: FixtureReplay): Promise<ContextPacket[]> => {
  const store = new WorkspaceRegistry(dir)
  try {
    store.saveSession(fixtureSession())
    await persistObservations(store, replay)
    const result = buildContextPackets({
      workspaceId: WS,
      sessionId: SES,
      session: store.getSession(WS, SES),
      sttSegments: store.listSttSegments(WS, SES),
      ocrResults: store.listOcrResults(WS, SES),
      moments: store.listMoments(WS, SES),
      entities: store.listEntities(WS),
      existing: store.listContextPackets(WS, { sessionId: SES, includeSuperseded: true }),
      now: replay.now,
    })
    assert.equal(result.created.length, 1, 'the fixture converges into exactly one window packet')
    for (const packet of result.created) store.saveContextPacket(packet)

    // Idempotence in the SAME store: an immediate rebuild over the persisted state appends nothing.
    const again = buildContextPackets({
      workspaceId: WS,
      sessionId: SES,
      session: store.getSession(WS, SES),
      sttSegments: store.listSttSegments(WS, SES),
      ocrResults: store.listOcrResults(WS, SES),
      moments: store.listMoments(WS, SES),
      entities: store.listEntities(WS),
      existing: store.listContextPackets(WS, { sessionId: SES, includeSuperseded: true }),
      now: () => new Date('2027-01-01T00:00:00.000Z'), // a different clock cannot change a no-op
    })
    assert.equal(again.created.length, 0, 'rebuild over the same observations appends nothing')

    return store.listContextPackets(WS, { sessionId: SES, includeSuperseded: true })
  } finally {
    store.close()
  }
}

test('#176 fixture replay: the same fixture replayed twice yields byte-identical ContextPackets, idempotently', async () => {
  const fixture = loadFixtureSync(new URL('../../../../tools/fixtures/fixtures/synthetic-converged.v1.json', import.meta.url))
  const replay = createFixtureReplay(fixture)

  const dirA = await mkdtemp(join(tmpdir(), 'openinfo-packets-replay-a-'))
  const dirB = await mkdtemp(join(tmpdir(), 'openinfo-packets-replay-b-'))
  try {
    const first = await replayAndBuild(dirA, replay)
    replay.reset()
    const second = await replayAndBuild(dirB, replay)

    assert.equal(JSON.stringify(first), JSON.stringify(second), 'replay × 2 ⇒ byte-identical packets')

    // The converged packet correlates the screen frame with BOTH audio lanes — attribution never merges.
    const packet = first[0]!
    assert.equal(packet.workspaceId, WS)
    assert.equal(packet.sessionId, SES)
    assert.equal(packet.windowStart, '2026-07-12T13:00:00.000Z')
    assert.equal(packet.windowEnd, '2026-07-12T13:01:00.000Z')
    assert.equal(packet.microphone.length, 1, 'the mic lane holds exactly the mic segment')
    assert.equal(packet.systemAudio.length, 1, 'the system-audio lane holds exactly its own segment')
    assert.equal(packet.screen.length, 1, 'the screen lane holds the OCR result')
    assert.notEqual(packet.microphone[0]!.id, packet.systemAudio[0]!.id, 'two audio lanes, two identities')
    assert.deepEqual(packet.gaps, [], 'all three senses present')
    assert.equal(packet.confidence, 0.9)
    assert.equal(packet.revision, 1)
    assert.deepEqual(packet.focus, [{ kind: 'window', detail: 'app: Fixture', weight: 0.5 }])
    assert.equal(packet.createdAt, '2026-07-12T13:00:03.000Z', 'createdAt = the fixture replay clock')

    // Refs stay refs: nothing transcribed or recognized was copied onto the packet.
    const bytes = JSON.stringify(packet)
    assert.ok(!bytes.includes('Please follow up'), 'no mic transcript content on the packet')
    assert.ok(!bytes.includes('I will review'), 'no system-audio transcript content on the packet')
    assert.ok(!bytes.includes('Pull request 150'), 'no screen text content on the packet')
  } finally {
    await rm(dirA, { recursive: true, force: true })
    await rm(dirB, { recursive: true, force: true })
  }
})
