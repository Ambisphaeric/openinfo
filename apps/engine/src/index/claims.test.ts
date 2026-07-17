import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Claim, ContextPacket, Entity, Moment } from '@openinfo/contracts'
import { buildClaims } from './claims.js'

/**
 * #178 slice 1 — the deterministic co-occurrence Claim builder, as a PURE function of its inputs (no DB, no
 * model, no clock beyond the injectable `now`). These pin the honest guarantees: co-occurrence is derived
 * ONLY from converged evidence, a pair with no evidence yields NO claim, confidence is a fixed inspectable
 * map, and the append-only supersession/idempotence is byte-stable.
 */

const WS = 'ws-claims'
const SES = 'ses-1'
const FIXED = () => new Date('2026-07-12T13:00:05.000Z')

const entity = (id: string): Entity => ({
  id, workspaceId: WS, kind: 'person', name: id, aliases: [], momentRefs: [], outboundCount: 0,
  firstSeen: '2026-07-12T13:00:00.000Z', lastSeen: '2026-07-12T13:00:00.000Z',
})

const moment = (id: string, refs: string[], at: string): Moment => ({
  id, sessionId: SES, workspaceId: WS, at, kind: 'mention', text: 'x', refs, source: 'mic', confidence: 0.9,
})

const packet = (id: string, candidateIds: string[], windowStart: string): ContextPacket => ({
  id, workspaceId: WS, sessionId: SES, windowStart, windowEnd: windowStart,
  microphone: [], systemAudio: [], screen: [],
  candidates: candidateIds.map((entityId) => ({ entityId, name: entityId, momentRefs: ['m'] })),
  gaps: [], confidence: 0.4, provenance: { builder: 'deterministic-correlation', windowMs: 60000 },
  revision: 1, schemaVersion: 1, createdAt: windowStart,
})

test('derives one co-occurs-with claim from a moment naming two entities (the only relation without a model)', () => {
  const { created } = buildClaims({
    workspaceId: WS, sessionId: SES, packets: [], moments: [moment('m1', ['ent-b', 'ent-a'], '2026-07-12T13:00:00.000Z')],
    entities: [entity('ent-a'), entity('ent-b')], existing: [], now: FIXED,
  })
  assert.equal(created.length, 1)
  const c = created[0]!
  assert.equal(c.relation, 'co-occurs-with')
  assert.equal(c.subject, 'ent-a', 'endpoints canonically ordered by id (symmetric relation)')
  assert.equal(c.object, 'ent-b')
  assert.equal(c.source, 'derived')
  assert.equal(c.state, 'provisional')
  assert.equal(c.confidence, 0.4, 'one evidence ref ⇒ 0.4 (fixed map)')
  assert.deepEqual(c.evidence, [{ record: 'moment', id: 'm1', at: '2026-07-12T13:00:00.000Z' }])
  assert.equal(c.provenance?.evidenceCount, 1)
  assert.equal(c.provenance?.builder, 'deterministic-cooccurrence')
  assert.equal(c.revision, 1)
  assert.equal(c.supersedes, undefined)
  assert.equal(c.createdAt, '2026-07-12T13:00:05.000Z', 'createdAt = the injected clock')
  assert.ok(c.id.startsWith('clm-'))
})

test('two independent evidence records (a packet + a moment) strengthen confidence via a recorded derivation', () => {
  const { created } = buildClaims({
    workspaceId: WS, sessionId: SES,
    packets: [packet('cp1', ['ent-a', 'ent-b'], '2026-07-12T13:00:00.000Z')],
    moments: [moment('m1', ['ent-a', 'ent-b'], '2026-07-12T13:00:04.000Z')],
    entities: [entity('ent-a'), entity('ent-b')], existing: [], now: FIXED,
  })
  assert.equal(created.length, 1)
  const c = created[0]!
  assert.equal(c.provenance?.evidenceCount, 2)
  assert.equal(c.confidence, 0.6, 'two evidence refs ⇒ 0.6')
  assert.deepEqual(c.evidence.map((e) => e.record), ['context-packet', 'moment'], 'evidence sorted by instant')
  assert.equal(c.firstObserved, '2026-07-12T13:00:00.000Z')
  assert.equal(c.lastObserved, '2026-07-12T13:00:04.000Z')
})

test('NO evidence ⇒ NO claim (honest degradation, never fabricated)', () => {
  // A single entity named alone, and a dangling ref to an entity with no record — neither is co-occurrence.
  const { created } = buildClaims({
    workspaceId: WS, sessionId: SES, packets: [], moments: [moment('m1', ['ent-a', 'ent-ghost'], '2026-07-12T13:00:00.000Z')],
    entities: [entity('ent-a')], existing: [], now: FIXED,
  })
  assert.deepEqual(created, [], 'a dangling ref has no record to trace to — no pair, no claim')
})

test('confidence is capped below 1.0 — a derived claim is a proposal, never certain', () => {
  const at = (n: number) => `2026-07-12T13:0${n}:00.000Z`
  const packets = [0, 1, 2, 3, 4].map((n) => packet(`cp${n}`, ['ent-a', 'ent-b'], at(n)))
  const { created } = buildClaims({
    workspaceId: WS, sessionId: SES, packets, moments: [], entities: [entity('ent-a'), entity('ent-b')], existing: [], now: FIXED,
  })
  assert.equal(created[0]!.provenance?.evidenceCount, 5)
  assert.equal(created[0]!.confidence, 0.85, '5 evidence refs ⇒ the 0.85 cap (1.0 is reserved for a user confirmation)')
})

test('idempotent: a rebuild over the same evidence appends nothing and keeps the existing claim byte-identical', () => {
  const input = {
    workspaceId: WS, sessionId: SES, packets: [], moments: [moment('m1', ['ent-a', 'ent-b'], '2026-07-12T13:00:00.000Z')],
    entities: [entity('ent-a'), entity('ent-b')], now: FIXED,
  }
  const first = buildClaims({ ...input, existing: [] })
  const second = buildClaims({ ...input, existing: first.created, now: () => new Date('2099-01-01T00:00:00.000Z') })
  assert.equal(second.created.length, 0, 'a different clock cannot change a no-op')
  assert.equal(second.unchanged.length, 1)
  assert.equal(JSON.stringify(second.unchanged[0]), JSON.stringify(first.created[0]))
})

test('append-only supersession: MORE evidence appends a new revision that supersedes the prior (never mutates it)', () => {
  const base = {
    workspaceId: WS, sessionId: SES, packets: [], entities: [entity('ent-a'), entity('ent-b')], now: FIXED,
  }
  const first = buildClaims({ ...base, moments: [moment('m1', ['ent-a', 'ent-b'], '2026-07-12T13:00:00.000Z')], existing: [] })
  const second = buildClaims({
    ...base,
    moments: [moment('m1', ['ent-a', 'ent-b'], '2026-07-12T13:00:00.000Z'), moment('m2', ['ent-a', 'ent-b'], '2026-07-12T13:00:10.000Z')],
    existing: first.created,
  })
  assert.equal(second.created.length, 1)
  const rev2 = second.created[0]!
  assert.equal(rev2.revision, 2)
  assert.equal(rev2.supersedes, first.created[0]!.id)
  assert.equal(rev2.provenance?.evidenceCount, 2)
  assert.notEqual(rev2.id, first.created[0]!.id, 'a new revision is a new content-derived id')
})

test('byte-identical: the same inputs built twice yield byte-identical claims (deterministic)', () => {
  const mk = () => buildClaims({
    workspaceId: WS, sessionId: SES,
    packets: [packet('cp1', ['ent-a', 'ent-b', 'ent-c'], '2026-07-12T13:00:00.000Z')],
    moments: [moment('m1', ['ent-c', 'ent-a'], '2026-07-12T13:00:04.000Z')],
    entities: [entity('ent-a'), entity('ent-b'), entity('ent-c')], existing: [], now: FIXED,
  })
  assert.equal(JSON.stringify(mk().created), JSON.stringify(mk().created))
  // three entities in one packet ⇒ all three unordered pairs; refs never carry copied content.
  const created = mk().created
  assert.equal(created.length, 3, 'C(3,2) = 3 co-occurrence pairs')
  const bytes = JSON.stringify(created)
  assert.ok(!bytes.includes('"text"'), 'no evidence content copied onto a claim')
})

test('claims are workspace-isolated and session-scoped — cross-session evidence never bleeds into one claim', () => {
  const { created } = buildClaims({
    workspaceId: WS, sessionId: SES, packets: [],
    moments: [moment('m1', ['ent-a', 'ent-b'], '2026-07-12T13:00:00.000Z'), { ...moment('m2', ['ent-a', 'ent-b'], '2026-07-12T13:00:10.000Z'), sessionId: 'other-session' }],
    entities: [entity('ent-a'), entity('ent-b')], existing: [], now: FIXED,
  })
  assert.equal(created.length, 1)
  assert.equal(created[0]!.provenance?.evidenceCount, 1, "only this session's moment is evidence")
})

test('the produced claim satisfies the append-only Claim contract shape it will be stored under', () => {
  const { created } = buildClaims({
    workspaceId: WS, sessionId: SES, packets: [], moments: [moment('m1', ['ent-a', 'ent-b'], '2026-07-12T13:00:00.000Z')],
    entities: [entity('ent-a'), entity('ent-b')], existing: [], now: FIXED,
  })
  const c: Claim = created[0]!
  assert.equal(c.schemaVersion, 1)
  assert.ok(c.evidence.length >= 1, 'evidence is mandatory')
})
