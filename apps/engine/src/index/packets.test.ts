import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Value } from '@sinclair/typebox/value'
import {
  ContextPacket as ContextPacketSchema,
  type ContextPacket,
  type Entity,
  type Moment,
  type OcrResult,
  type Session,
  type SttSegment,
} from '@openinfo/contracts'
import { buildContextPackets, DEFAULT_PACKET_BUILDER_CONFIG, type PacketBuildInput } from './packets.js'

const WS = 'ws-packets'
const SES = 'ses-packets'
const T0 = Date.UTC(2026, 6, 12, 13, 0, 0) // 2026-07-12T13:00:00.000Z — a windowMs-aligned instant

const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString()

const segment = (id: string, source: 'mic' | 'system-audio', offsetMs: number): SttSegment => ({
  id,
  workspaceId: WS,
  sessionId: SES,
  chunkId: `cap-${id}`,
  source,
  capturedAt: iso(offsetMs),
  processedAt: iso(offsetMs + 500),
  textChars: 40,
  provenance: { slot: 'stt', endpoint: 'fixture-parakeet' },
  schemaVersion: 1,
  createdAt: iso(offsetMs + 500),
})

const ocr = (id: string, text: string, offsetMs: number): OcrResult => ({
  id,
  sessionId: SES,
  workspaceId: WS,
  sourceChunks: [`cap-${id}`],
  text,
  provenance: { slot: 'ocr', endpoint: 'fixture-ocr' },
  schemaVersion: 1,
  createdAt: iso(offsetMs + 300),
  capturedAt: iso(offsetMs),
})

const moment = (id: string, offsetMs: number, refs: string[]): Moment => ({
  id,
  sessionId: SES,
  workspaceId: WS,
  at: iso(offsetMs),
  kind: 'mention',
  text: 'synthetic mention',
  refs,
  source: 'mic',
  confidence: 0.8,
})

const entity = (id: string, name: string, aliases: string[] = []): Entity => ({
  id,
  workspaceId: WS,
  kind: 'artifact',
  name,
  aliases,
  momentRefs: [],
  outboundCount: 0,
  mentions: 1,
  firstSeen: iso(0),
  lastSeen: iso(0),
})

const session = (evidence: Session['attribution']['evidence'] = []): Session => ({
  id: SES,
  workspaceId: WS,
  modeId: 'mode-meeting',
  startedAt: iso(0),
  attribution: { evidence, confidence: 1 },
})

const baseInput = (over: Partial<PacketBuildInput> = {}): PacketBuildInput => ({
  workspaceId: WS,
  sessionId: SES,
  session: session(),
  sttSegments: [],
  ocrResults: [],
  moments: [],
  entities: [],
  existing: [],
  now: () => new Date(T0 + 90_000),
  ...over,
})

test('#176: one window correlates a screen observation with BOTH audio lanes without merging attribution', () => {
  const { created, unchanged } = buildContextPackets(
    baseInput({
      sttSegments: [segment('stt-mic-1', 'mic', 0), segment('stt-sys-1', 'system-audio', 1_000)],
      ocrResults: [ocr('ocr-1', 'Pull request 150 — checks passing', 2_000)],
    }),
  )
  assert.equal(unchanged.length, 0)
  assert.equal(created.length, 1, 'all three observations share one 60s window')
  const packet = created[0]!
  assert.deepEqual([...Value.Errors(ContextPacketSchema, packet)], [], 'packet validates against the contract')
  // Source identity: each lane holds ONLY its own refs — audio lanes never merge, screen stays screen.
  assert.deepEqual(packet.microphone, [{ record: 'stt-segment', id: 'stt-mic-1', at: iso(0) }])
  assert.deepEqual(packet.systemAudio, [{ record: 'stt-segment', id: 'stt-sys-1', at: iso(1_000) }])
  assert.deepEqual(packet.screen, [{ record: 'ocr-result', id: 'ocr-1', at: iso(2_000) }])
  assert.equal(packet.windowStart, iso(0))
  assert.equal(packet.windowEnd, iso(60_000))
  assert.deepEqual(packet.gaps, [], 'no missing sense — nothing to disclose')
  assert.equal(packet.confidence, 0.9, 'three independent lanes ⇒ the top deterministic confidence')
  assert.equal(packet.revision, 1)
  assert.equal(packet.supersedes, undefined)
  assert.equal(packet.provenance.builder, 'deterministic-correlation')
  assert.equal(packet.provenance.windowMs, DEFAULT_PACKET_BUILDER_CONFIG.windowMs)
})

test('#176: a missing sense degrades to a partial packet with an explicit machine-readable reason — never a guess', () => {
  // mic speaks in both windows; the screen was only seen in window 1; system-audio never produced anything.
  const { created } = buildContextPackets(
    baseInput({
      sttSegments: [segment('stt-mic-1', 'mic', 0), segment('stt-mic-2', 'mic', 61_000)],
      ocrResults: [ocr('ocr-1', 'Pull request 150', 2_000)],
    }),
  )
  assert.equal(created.length, 2)
  const [first, second] = created as [ContextPacket, ContextPacket]
  // Window 1: system-audio is absent from the WHOLE session — the stronger absence.
  assert.deepEqual(first.gaps, [{ lane: 'system-audio', reason: 'no-observations-this-session' }])
  assert.equal(first.confidence, 0.7, 'two lanes present')
  // Window 2: the screen exists in this session but was silent THIS window; system-audio still session-absent.
  assert.deepEqual(second.gaps, [
    { lane: 'system-audio', reason: 'no-observations-this-session' },
    { lane: 'screen', reason: 'no-observations-in-window' },
  ])
  assert.equal(second.confidence, 0.4, 'one lane present')
  assert.deepEqual(second.screen, [], 'no fabricated refs for a missing sense')
  for (const packet of created) assert.deepEqual([...Value.Errors(ContextPacketSchema, packet)], [])
})

test('#176: candidates come from in-window moment evidence, and the #74 correlator adds screen corroboration with provenance', () => {
  const pidev = entity('ent-pidev', 'pi.dev', ['pie dev'])
  const offband = entity('ent-off', 'Quarterly Numbers')
  const { created } = buildContextPackets(
    baseInput({
      sttSegments: [segment('stt-mic-1', 'mic', 0)],
      ocrResults: [ocr('ocr-1', 'acme/pi.dev · Pull requests', 2_000)],
      moments: [
        moment('m-1', 3_000, ['ent-pidev', 'ent-off']),
        moment('m-2', 4_000, ['ent-pidev', 'ent-dangling']), // a ref without a record is never fabricated into evidence
        moment('m-late', 70_000, ['ent-off']), // outside the window — contributes nothing here
      ],
      entities: [pidev, offband],
    }),
  )
  assert.equal(created.length, 1)
  const packet = created[0]!
  assert.deepEqual(
    packet.candidates.map((c) => c.entityId),
    ['ent-off', 'ent-pidev'],
    'deterministic order; the dangling ref is dropped',
  )
  const seen = packet.candidates.find((c) => c.entityId === 'ent-pidev')!
  assert.deepEqual(seen.momentRefs, ['m-1', 'm-2'], 'traceable to the exact in-window moments')
  assert.ok(seen.seenOnScreen, 'the screen independently names pi.dev')
  assert.equal(seen.seenOnScreen!.ocrId, 'ocr-1', 'corroboration names the exact OcrResult')
  assert.equal(seen.seenOnScreen!.form, 'pi.dev', 'and the on-screen form that matched')
  assert.ok(seen.seenOnScreen!.similarity >= DEFAULT_PACKET_BUILDER_CONFIG.correlation.matchThreshold)
  const unseen = packet.candidates.find((c) => c.entityId === 'ent-off')!
  assert.equal(unseen.seenOnScreen, undefined, 'no screen agreement ⇒ no corroboration claim')
})

test('#176: focus/app evidence comes from the session record — window/repo kinds only, omitted when absent', () => {
  const withFocus = buildContextPackets(
    baseInput({
      session: session([
        { kind: 'window', detail: 'app: Code', weight: 0.6 },
        { kind: 'repo', detail: 'repo: openinfo', weight: 0.7 },
        { kind: 'manual', detail: 'started manually', weight: 1 }, // not foreground evidence
      ]),
      sttSegments: [segment('stt-mic-1', 'mic', 0)],
    }),
  )
  assert.deepEqual(withFocus.created[0]!.focus, [
    { kind: 'window', detail: 'app: Code', weight: 0.6 },
    { kind: 'repo', detail: 'repo: openinfo', weight: 0.7 },
  ])
  const withoutFocus = buildContextPackets(baseInput({ sttSegments: [segment('stt-mic-1', 'mic', 0)] }))
  assert.equal(withoutFocus.created[0]!.focus, undefined, 'no evidence ⇒ the field is absent, never invented')
})

test('#176: rebuilding from the same observations is an idempotent no-op — byte-identical packets, nothing appended', () => {
  const input = baseInput({
    sttSegments: [segment('stt-mic-1', 'mic', 0), segment('stt-sys-1', 'system-audio', 1_000)],
    ocrResults: [ocr('ocr-1', 'Pull request 150', 2_000)],
  })
  const first = buildContextPackets(input)
  assert.equal(first.created.length, 1)
  const again = buildContextPackets({ ...input, existing: first.created, now: () => new Date(T0 + 999_000) })
  assert.equal(again.created.length, 0, 'nothing new to append')
  assert.equal(again.unchanged.length, 1)
  assert.equal(JSON.stringify(again.unchanged), JSON.stringify(first.created), 'byte-identical, clock irrelevant')
})

test('#176: a late observation appends a supersession revision — the prior packet is linked, never mutated', () => {
  const partial = baseInput({ sttSegments: [segment('stt-mic-1', 'mic', 0)] })
  const first = buildContextPackets(partial)
  assert.equal(first.created.length, 1)
  const v1 = first.created[0]!
  const v1Bytes = JSON.stringify(v1)
  assert.deepEqual(v1.gaps.map((g) => g.lane), ['system-audio', 'screen'])

  // The screen frame arrives late (out of order), into the SAME already-packeted window.
  const late = buildContextPackets({
    ...partial,
    ocrResults: [ocr('ocr-late', 'Pull request 150', 2_000)],
    existing: first.created,
  })
  assert.equal(late.created.length, 1)
  const v2 = late.created[0]!
  assert.equal(v2.revision, 2)
  assert.equal(v2.supersedes, v1.id, 'the chain is linked')
  assert.notEqual(v2.id, v1.id, 'a revision is a NEW record')
  assert.deepEqual(v2.gaps, [{ lane: 'system-audio', reason: 'no-observations-this-session' }])
  assert.deepEqual(v2.screen.map((r) => r.id), ['ocr-late'])
  assert.equal(JSON.stringify(v1), v1Bytes, 'the superseded packet is untouched')

  // Converged: a further rebuild over the full chain appends nothing.
  const settled = buildContextPackets({
    ...partial,
    ocrResults: [ocr('ocr-late', 'Pull request 150', 2_000)],
    existing: [...first.created, ...late.created],
  })
  assert.equal(settled.created.length, 0)
  assert.deepEqual(settled.unchanged.map((p) => p.id), [v2.id], 'the chain head is the live packet')
})

test('#176: packet bytes are independent of input read order, and corrupt timestamps are skipped, never guessed', () => {
  const ordered = baseInput({
    sttSegments: [segment('stt-mic-1', 'mic', 0), segment('stt-mic-2', 'mic', 5_000), segment('stt-sys-1', 'system-audio', 1_000)],
    ocrResults: [ocr('ocr-1', 'Pull request 150', 2_000), ocr('ocr-2', 'checks passing', 3_000)],
  })
  const shuffled = baseInput({
    sttSegments: [segment('stt-sys-1', 'system-audio', 1_000), segment('stt-mic-2', 'mic', 5_000), segment('stt-mic-1', 'mic', 0)],
    ocrResults: [ocr('ocr-2', 'checks passing', 3_000), ocr('ocr-1', 'Pull request 150', 2_000)],
  })
  assert.equal(
    JSON.stringify(buildContextPackets(ordered).created),
    JSON.stringify(buildContextPackets(shuffled).created),
    'read order never leaks into packet bytes',
  )

  const corrupt = { ...segment('stt-bad', 'mic', 0), capturedAt: 'not-a-time' }
  const built = buildContextPackets(baseInput({ sttSegments: [corrupt as SttSegment, segment('stt-mic-1', 'mic', 0)] }))
  assert.equal(built.created.length, 1)
  assert.deepEqual(built.created[0]!.microphone.map((r) => r.id), ['stt-mic-1'], 'the unparseable observation is excluded')
})

test("#176: another session's observations never leak into this session's packets", () => {
  const foreign: SttSegment = { ...segment('stt-foreign', 'mic', 0), sessionId: 'ses-other' }
  const built = buildContextPackets(baseInput({ sttSegments: [foreign, segment('stt-mic-1', 'mic', 0)] }))
  assert.equal(built.created.length, 1)
  assert.deepEqual(built.created[0]!.microphone.map((r) => r.id), ['stt-mic-1'])
})
