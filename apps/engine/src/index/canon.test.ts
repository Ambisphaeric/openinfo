import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Entity } from '@openinfo/contracts'
import { mergeCanon } from './canon.js'

const entity = (over: Partial<Entity> & { id: string; name: string }): Entity => ({
  workspaceId: 'ws-canon',
  kind: 'person',
  aliases: [],
  momentRefs: [],
  outboundCount: 0,
  mentions: 1,
  firstSeen: '2026-07-07T10:00:00Z',
  lastSeen: '2026-07-07T14:00:00Z',
  ...over,
})

test('reference merging: two records sharing an alias collapse into one canonical record', () => {
  const a = entity({ id: 'ent-a', name: 'Dana', aliases: ['Dana Cruz'], mentions: 2, momentRefs: ['m1'] })
  const b = entity({ id: 'ent-b', name: 'Dana Cruz', aliases: [], mentions: 3, momentRefs: ['m2'], firstSeen: '2026-07-07T09:00:00Z' })
  const { entities, groups } = mergeCanon([a, b])
  assert.equal(entities.length, 1)
  const merged = entities[0]!
  // canonical winner: equal outbound → more mentions wins (b, 3 > 2)
  assert.equal(merged.id, 'ent-b')
  assert.equal(merged.mentions, 5) // summed
  assert.deepEqual([...merged.momentRefs].sort(), ['m1', 'm2'])
  assert.deepEqual(merged.canonicalOf, ['ent-a']) // the folded-in id
  // every surface form is now an alias of the canonical record
  assert.ok(merged.aliases.includes('Dana'))
  assert.equal(merged.firstSeen, '2026-07-07T09:00:00Z') // earliest across the group
  // group inspection
  assert.equal(groups.length, 1)
  assert.equal(groups[0]!.merged.length, 1)
})

test('transitive merge: A~B via one alias, B~C via another → one group of three', () => {
  const a = entity({ id: 'a', name: 'Ada', aliases: ['A. Lovelace'] })
  const b = entity({ id: 'b', name: 'A. Lovelace', aliases: ['Countess'] })
  const c = entity({ id: 'c', name: 'Countess', aliases: [] })
  const { entities } = mergeCanon([a, b, c])
  assert.equal(entities.length, 1)
  assert.deepEqual(entities[0]!.canonicalOf!.length, 2)
})

test('different kinds never merge (a person and a topic named "Ada" stay distinct)', () => {
  const person = entity({ id: 'p', name: 'Ada', kind: 'person' })
  const topic = entity({ id: 't', name: 'Ada', kind: 'topic' })
  const { entities } = mergeCanon([person, topic])
  assert.equal(entities.length, 2)
})

test('outbound wins canon precedence over mentions (sent outranks viewed for WHICH is canonical)', () => {
  const sent = entity({ id: 'sent', name: 'Deck', kind: 'artifact', aliases: ['The Deck'], outboundCount: 1, mentions: 1 })
  const viewed = entity({ id: 'viewed', name: 'The Deck', kind: 'artifact', outboundCount: 0, mentions: 9 })
  const { entities } = mergeCanon([viewed, sent])
  assert.equal(entities.length, 1)
  assert.equal(entities[0]!.id, 'sent') // the sent version is canonical despite fewer mentions
  assert.equal(entities[0]!.outboundCount, 1) // summed
  assert.equal(entities[0]!.mentions, 10)
})

test('singletons pass through unchanged; output is deterministic regardless of input order', () => {
  const a = entity({ id: 'a', name: 'Alpha', firstSeen: '2026-07-07T08:00:00Z' })
  const b = entity({ id: 'b', name: 'Beta', firstSeen: '2026-07-07T09:00:00Z' })
  const one = mergeCanon([a, b]).entities.map((e) => e.id)
  const two = mergeCanon([b, a]).entities.map((e) => e.id)
  assert.deepEqual(one, two)
  assert.deepEqual(one, ['a', 'b']) // ordered by canonical firstSeen then id
  // a true singleton is returned byte-identical (no canonicalOf invented)
  assert.equal(mergeCanon([a]).entities[0]!.canonicalOf, undefined)
})
