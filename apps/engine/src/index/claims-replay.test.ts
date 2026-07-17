import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Claim, ContextPacket, Entity, Moment } from '@openinfo/contracts'
import { WorkspaceRegistry } from '../store/index.js'
import { buildClaims } from './claims.js'

/**
 * #178 determinism proof: the SAME deterministic evidence built twice — into two fresh, isolated stores —
 * yields byte-identical persisted Claims (same content-derived ids), and a rebuild over an already-built
 * store appends nothing (idempotence). No model, capture, or network is touched: claims are a PURE function
 * of the converged evidence (packets + moments + entities), so the guarantee is structural, mirroring the
 * #176/#177 replay pattern. (Entity ids are hand-fixed here because the store mints entity ids randomly;
 * the property under test is the builder + store round-trip, which must be byte-stable.)
 */

const WS = 'workspace-synthetic'
const SES = 'session-synthetic'
const REPLAY_CLOCK = () => new Date('2026-07-12T13:00:05.000Z')

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

const EVIDENCE = {
  workspaceId: WS,
  sessionId: SES,
  packets: [packet('cp-0001', ['ent-ada', 'ent-pidev'], '2026-07-12T13:00:00.000Z')],
  moments: [moment('moment-0001', ['ent-pidev', 'ent-ada'], '2026-07-12T13:00:04.000Z')],
  entities: [entity('ent-ada'), entity('ent-pidev')],
  now: REPLAY_CLOCK,
}

/** Build the claims into a fresh store and read them back through the store's live-head resolution. */
const buildAndPersist = async (dir: string): Promise<Claim[]> => {
  const store = new WorkspaceRegistry(dir)
  try {
    const result = buildClaims({ ...EVIDENCE, existing: store.listClaims(WS, { sessionId: SES, source: 'derived', includeSuperseded: true }) })
    assert.equal(result.created.length, 1, 'the evidence converges into exactly one co-occurrence claim')
    for (const claim of result.created) store.saveClaim(claim)

    // Idempotence in the SAME store: an immediate rebuild over the persisted chain appends nothing.
    const again = buildClaims({
      ...EVIDENCE,
      existing: store.listClaims(WS, { sessionId: SES, source: 'derived', includeSuperseded: true }),
      now: () => new Date('2099-01-01T00:00:00.000Z'), // a different clock cannot change a no-op
    })
    assert.equal(again.created.length, 0, 'rebuild over the same evidence appends nothing')

    return store.listClaims(WS, { sessionId: SES, includeSuperseded: true })
  } finally {
    store.close()
  }
}

test('#178 replay: the same evidence built into two fresh stores yields byte-identical Claims, idempotently', async () => {
  const dirA = await mkdtemp(join(tmpdir(), 'openinfo-claims-replay-a-'))
  const dirB = await mkdtemp(join(tmpdir(), 'openinfo-claims-replay-b-'))
  try {
    const first = await buildAndPersist(dirA)
    const second = await buildAndPersist(dirB)

    assert.equal(JSON.stringify(first), JSON.stringify(second), 'build × 2 ⇒ byte-identical claims')

    const claim = first[0]!
    assert.equal(claim.subject, 'ent-ada', 'symmetric endpoints canonically ordered by id')
    assert.equal(claim.object, 'ent-pidev')
    assert.equal(claim.relation, 'co-occurs-with')
    assert.equal(claim.provenance?.evidenceCount, 2, 'a packet + a moment back the pair')
    assert.equal(claim.confidence, 0.6)
    assert.equal(claim.revision, 1)
    assert.equal(claim.createdAt, '2026-07-12T13:00:05.000Z', 'createdAt = the replay clock')

    // Refs stay refs: nothing observed was copied onto the claim.
    const bytes = JSON.stringify(claim)
    assert.ok(!bytes.includes('"text"'), 'no evidence content copied onto the claim')
    assert.deepEqual(
      claim.evidence.map((e) => e.record).sort(),
      ['context-packet', 'moment'],
      'the claim points at its evidence records by id only',
    )
  } finally {
    await rm(dirA, { recursive: true, force: true })
    await rm(dirB, { recursive: true, force: true })
  }
})
