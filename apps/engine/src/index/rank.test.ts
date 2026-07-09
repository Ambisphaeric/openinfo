import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Entity } from '@openinfo/contracts'
import { DEFAULT_RANK_CONFIG, rankEntities, scoreEntity } from './rank.js'

const now = new Date('2026-07-07T15:00:00Z')

const entity = (over: Partial<Entity> & { name: string }): Entity => ({
  id: `ent-${over.name}`,
  workspaceId: 'ws-rank',
  kind: 'topic',
  aliases: [],
  momentRefs: [],
  outboundCount: 0,
  mentions: 1,
  firstSeen: '2026-07-07T10:00:00Z',
  lastSeen: '2026-07-07T14:00:00Z',
  ...over,
})

test('recency dominance: same mentions, fresher lastSeen wins', () => {
  const fresh = entity({ name: 'fresh', mentions: 3, lastSeen: '2026-07-07T14:59:00Z' })
  const stale = entity({ name: 'stale', mentions: 3, lastSeen: '2026-07-07T03:00:00Z' })
  const ranked = rankEntities([stale, fresh], now)
  assert.deepEqual(ranked.map((r) => r.entity.name), ['fresh', 'stale'])
  assert.ok(ranked[0]!.score > ranked[1]!.score)
})

test('frequency dominance: same lastSeen, more mentions wins', () => {
  const loud = entity({ name: 'loud', mentions: 8, lastSeen: '2026-07-07T14:00:00Z' })
  const quiet = entity({ name: 'quiet', mentions: 1, lastSeen: '2026-07-07T14:00:00Z' })
  const ranked = rankEntities([quiet, loud], now)
  assert.deepEqual(ranked.map((r) => r.entity.name), ['loud', 'quiet'])
})

test('recency can outweigh raw frequency (log damping + half-life decay)', () => {
  // 16 mentions but last seen 12h ago (3 half-lives at the default 4h) vs 2 mentions just now:
  // (1+log2(16)) * 0.5^3 = 5*0.125 = 0.625  <  (1+log2(2)) * ~1 = 2
  const oldTopic = entity({ name: 'old-topic', mentions: 16, lastSeen: '2026-07-07T03:00:00Z' })
  const liveTopic = entity({ name: 'live-topic', mentions: 2, lastSeen: '2026-07-07T15:00:00Z' })
  const ranked = rankEntities([oldTopic, liveTopic], now)
  assert.deepEqual(ranked.map((r) => r.entity.name), ['live-topic', 'old-topic'])
})

test('score formula: (1 + log2(mentions)) × 0.5^(ageHours/halfLife)', () => {
  const e = entity({ name: 'x', mentions: 4, lastSeen: '2026-07-07T11:00:00Z' }) // 4h old = 1 half-life
  assert.ok(Math.abs(scoreEntity(e, now) - (1 + 2) * 0.5) < 1e-9)
  // half-life override is respected
  assert.ok(Math.abs(scoreEntity(e, now, { halfLifeHours: 8, outboundBoost: 1 }) - 3 * 0.5 ** 0.5) < 1e-9)
  // missing/zero mentions score as one mention (frequency floor), future lastSeen clamps to age 0
  const bare = entity({ name: 'bare', lastSeen: '2026-07-07T15:30:00Z' })
  delete (bare as { mentions?: number }).mentions
  assert.equal(scoreEntity(bare, now), 1)
  assert.equal(DEFAULT_RANK_CONFIG.halfLifeHours, 4)
})

test('canon weight: sent outranks an equally-frequent, equally-recent merely-viewed entity', () => {
  const sent = entity({ name: 'sent', mentions: 4, outboundCount: 1 })
  const viewed = entity({ name: 'viewed', mentions: 4, outboundCount: 0 })
  const ranked = rankEntities([viewed, sent], now)
  assert.deepEqual(ranked.map((r) => r.entity.name), ['sent', 'viewed'])
  // one send at outboundBoost 1 doubles the score: canon factor = 1 + 1·log2(1+1) = 2
  assert.ok(Math.abs(ranked[0]!.score - 2 * ranked[1]!.score) < 1e-9)
})

test('canon weight: outboundCount 0 leaves the score EXACTLY unchanged (honest v0 default)', () => {
  const e = entity({ name: 'x', mentions: 4, lastSeen: '2026-07-07T11:00:00Z', outboundCount: 0 })
  // identical to the pre-canon formula (1 + log2 4) × 0.5^1
  assert.ok(Math.abs(scoreEntity(e, now) - (1 + 2) * 0.5) < 1e-9)
  // outboundBoost 0 disables the canon factor even for a sent entity
  const sent = entity({ name: 'y', mentions: 4, lastSeen: '2026-07-07T11:00:00Z', outboundCount: 5 })
  assert.ok(Math.abs(scoreEntity(sent, now, { halfLifeHours: 4, outboundBoost: 0 }) - (1 + 2) * 0.5) < 1e-9)
})

test('canon weight is log-damped: a 40×-sent artifact cannot dwarf everything', () => {
  const loud = entity({ name: 'loud', mentions: 1, outboundCount: 40 })
  const quiet = entity({ name: 'quiet', mentions: 1, outboundCount: 1 })
  // 40 sends is log2(41)≈5.36 vs 1 send log2(2)=1 — a ~3.2× gap, not 40×
  assert.ok(scoreEntity(loud, now) / scoreEntity(quiet, now) < 4)
})

test('tie cases: equal score breaks on lastSeen desc, then name asc — deterministic', () => {
  const a = entity({ name: 'alpha', mentions: 2, lastSeen: '2026-07-07T14:00:00Z' })
  const b = entity({ name: 'beta', mentions: 2, lastSeen: '2026-07-07T14:00:00Z' })
  const later = entity({ name: 'zeta', mentions: 2, lastSeen: '2026-07-07T14:30:00Z' })
  // scores of a and b are identical; zeta same mentions but fresher
  assert.deepEqual(rankEntities([b, later, a], now).map((r) => r.entity.name), ['zeta', 'alpha', 'beta'])
  assert.deepEqual(rankEntities([a, later, b], now).map((r) => r.entity.name), ['zeta', 'alpha', 'beta'])
})
