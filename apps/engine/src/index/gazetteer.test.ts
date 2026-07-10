import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Entity } from '@openinfo/contracts'
import { DEFAULT_RESOLVER_CONFIG, resolveEntity } from './resolve.js'
import { DEFAULT_GAZETTEER, gazetteerRivalId, gazetteerRivals, type GazetteerDocument } from './gazetteer.js'

const NOW = new Date('2026-07-10T12:00:00Z')
const AT = '2026-07-10T12:00:00Z'

/** Minimal entity builder — only the fields the resolver reads. */
const ent = (over: Partial<Entity> & Pick<Entity, 'id' | 'kind' | 'name'>): Entity => ({
  workspaceId: 'ws',
  aliases: [],
  momentRefs: [],
  outboundCount: 0,
  mentions: 1,
  firstSeen: '2026-07-10T11:00:00Z',
  lastSeen: '2026-07-10T11:00:00Z',
  ...over,
})

test('#143 gazetteerRivalId is a stable, namespaced synthetic id', () => {
  assert.equal(gazetteerRivalId('Kubeflow'), 'gaz:kubeflow')
  assert.equal(gazetteerRivalId('PostgreSQL'), 'gaz:postgresql')
  assert.equal(gazetteerRivalId('Apache Kafka'), 'gaz:apache-kafka')
  // stable across calls (pure function of the name)
  assert.equal(gazetteerRivalId('Kubeflow'), gazetteerRivalId('Kubeflow'))
})

test('#143 matcher offers a rival for a heard form that sounds like a public name', () => {
  const rivals = gazetteerRivals(['cube flow'], DEFAULT_GAZETTEER, { kind: 'artifact', at: AT })
  const kubeflow = rivals.find((r) => r.id === 'gaz:kubeflow')
  assert.ok(kubeflow, 'Kubeflow offered as a rival for "cube flow"')
  assert.equal(kubeflow!.name, 'Kubeflow')
  assert.equal(kubeflow!.kind, 'artifact', 'synthetic rival takes the heard kind')
  assert.equal(kubeflow!.mentions, 0, 'no establishment ⇒ neutral corpusPrior ⇒ never out-boosts corpus')
})

test('#143 matcher matches on an ALIAS (k8s → Kubernetes)', () => {
  const rivals = gazetteerRivals(['k8s'], DEFAULT_GAZETTEER, { kind: 'artifact', at: AT })
  assert.ok(rivals.some((r) => r.id === 'gaz:kubernetes'), 'k8s alias resolves to Kubernetes')
})

test('#143 matcher stays quiet for a form that matches no public name', () => {
  assert.deepEqual(gazetteerRivals(['quarterly planning sync'], DEFAULT_GAZETTEER, { kind: 'topic', at: AT }), [])
  assert.deepEqual(gazetteerRivals([], DEFAULT_GAZETTEER, { kind: 'topic', at: AT }), [])
})

test('#143 matcher floor respects the resolver band — a weak near-miss is not offered', () => {
  const doc: GazetteerDocument = { entries: [{ name: 'Kubeflow' }] }
  // "meeting" shares nothing with Kubeflow ⇒ below provisionalBand ⇒ no rival.
  assert.deepEqual(gazetteerRivals(['meeting'], doc, { kind: 'topic', at: AT }), [])
  // A high floor suppresses even a decent match; a low floor admits it — the store passes the band.
  assert.deepEqual(gazetteerRivals(['cube flow'], doc, { kind: 'artifact', at: AT, floor: 0.99 }), [])
  assert.equal(gazetteerRivals(['cube flow'], doc, { kind: 'artifact', at: AT, floor: 0.5 }).length, 1)
})

test('#143 CORPUS-vs-GAZETTEER collision flags AMBIGUOUS with the public name as the rival', () => {
  // An internal repo that reused the famous name — the collision the clarify gate exists for.
  const internalRepo = ent({ id: 'e-internal', kind: 'artifact', name: 'Kubeflow' })
  const rivals = gazetteerRivals(['cube flow'], DEFAULT_GAZETTEER, { kind: 'artifact', at: AT })
  const r = resolveEntity({ heard: { name: 'cube flow' }, candidates: [internalRepo], now: NOW, rivals })

  assert.equal(r.match?.id, 'e-internal', 'winner is the CORPUS entity — never the gazetteer')
  assert.equal(r.ambiguous, true, 'the public rival within the margin marks it ambiguous')
  assert.equal(r.rival?.entity.id, 'gaz:kubeflow', 'the gazetteer hit is the named rival')
  assert.equal(r.rival?.entity.name, 'Kubeflow')
  assert.ok(r.margin !== undefined && r.margin <= DEFAULT_RESOLVER_CONFIG.ambiguityMargin)
})

test('#143 GAZETTEER-ONLY hit (no corpus rival) stays SILENT — never a match, never ambiguous', () => {
  const rivals = gazetteerRivals(['cube flow'], DEFAULT_GAZETTEER, { kind: 'artifact', at: AT })
  const r = resolveEntity({ heard: { name: 'cube flow' }, candidates: [], now: NOW, rivals })
  assert.equal(r.band, 'new', 'nothing in the corpus to link to')
  assert.equal(r.match, undefined, 'a gazetteer hit is NEVER linked to / created')
  assert.equal(r.ambiguous, false, 'no corpus link ⇒ no ≟ ask')
})

test('#143 a gazetteer-only hit alongside a WEAK (below-band) corpus near-miss still stays silent', () => {
  // Corpus has an unrelated artifact; heard "cube flow" links to nothing ⇒ new band ⇒ gazetteer ignored.
  const unrelated = ent({ id: 'e-x', kind: 'artifact', name: 'renewal dashboard' })
  const rivals = gazetteerRivals(['cube flow'], DEFAULT_GAZETTEER, { kind: 'artifact', at: AT })
  const r = resolveEntity({ heard: { name: 'cube flow' }, candidates: [unrelated], now: NOW, rivals })
  assert.equal(r.band, 'new')
  assert.equal(r.ambiguous, false)
})

test('#143 a rejected gazetteer rival is never re-offered (rejectedRivalId honored)', () => {
  // The corpus entity carries a sovereign override: heard "cube flow" pinned here, gazetteer Kubeflow rejected.
  const internalRepo = ent({
    id: 'e-internal',
    kind: 'artifact',
    name: 'Kubeflow',
    overrides: [{ at: AT, by: 'the user', pinnedName: 'cube flow', rejectedRivalId: 'gaz:kubeflow' }],
  })
  const rivals = gazetteerRivals(['cube flow'], DEFAULT_GAZETTEER, { kind: 'artifact', at: AT })
  const r = resolveEntity({ heard: { name: 'cube flow' }, candidates: [internalRepo], now: NOW, rivals })
  assert.equal(r.match?.id, 'e-internal')
  assert.equal(r.ambiguous, false, 'the settled public rival is dropped, so no ≟ re-appears')
  assert.notEqual(r.rival?.entity.id, 'gaz:kubeflow')
})

test('#143 no rivals passed ⇒ resolver behavior is byte-identical (regression guard)', () => {
  const internalRepo = ent({ id: 'e-internal', kind: 'artifact', name: 'Kubeflow' })
  const withEmpty = resolveEntity({ heard: { name: 'cube flow' }, candidates: [internalRepo], now: NOW, rivals: [] })
  const without = resolveEntity({ heard: { name: 'cube flow' }, candidates: [internalRepo], now: NOW })
  assert.deepEqual(withEmpty, without)
  assert.equal(without.ambiguous, false, 'without a gazetteer rival, a lone corpus link is clean')
})
