import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Entity } from '@openinfo/contracts'
import { corpusPrior, DEFAULT_RESOLVER_CONFIG, phoneticFuzzy, resolveEntity } from './resolve.js'

const NOW = new Date('2026-07-10T12:00:00Z')

/** Minimal entity builder — only the fields the resolver reads; ids/timestamps are stable for assertions. */
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

// The corpus the mangled mentions resolve against.
const pidev = ent({ id: 'e-pidev', kind: 'artifact', name: 'pi.dev', aliases: ['pi dev repo'] })
const dana = ent({ id: 'e-dana', kind: 'person', name: 'Dana Cruz', aliases: ['Dana'], mentions: 6 })
const github = ent({ id: 'e-gh', kind: 'artifact', name: 'github' })
const renewal = ent({ id: 'e-ren', kind: 'topic', name: 'renewal' })

test('exact match resolves with score 1, band auto (regression fixture)', () => {
  for (const [heard, cand] of [
    ['pi.dev', pidev],
    ['Dana Cruz', dana],
    ['github', github],
    ['renewal', renewal],
  ] as const) {
    const r = resolveEntity({ heard: { name: heard }, candidates: [cand], now: NOW })
    assert.equal(r.match?.id, cand.id, `${heard} → ${cand.id}`)
    assert.equal(r.score, 1, `${heard} score`)
    assert.equal(r.band, 'auto', `${heard} band`)
    assert.equal(r.components.phoneticFuzzy, 1)
    assert.equal(r.ambiguous, false)
  }
})

test('matching an existing ALIAS resolves exact (score 1, auto)', () => {
  const r = resolveEntity({ heard: { name: 'Dana' }, candidates: [dana], now: NOW })
  assert.equal(r.match?.id, dana.id)
  assert.equal(r.score, 1)
  assert.equal(r.band, 'auto')
})

test('mangled-names fixture: ASR corruptions resolve to the right record', () => {
  const corpus = [pidev, dana, github, renewal]
  // [heard mention, expected match id, expected band-or-better]
  const cases: { heard: string; id: string; minBand: 'auto' | 'provisional' }[] = [
    { heard: 'pie dev', id: 'e-pidev', minBand: 'provisional' }, // homophone + dropped punctuation
    { heard: 'pi dev', id: 'e-pidev', minBand: 'auto' }, // dropped punctuation
    { heard: 'git hub', id: 'e-gh', minBand: 'auto' }, // split token
    { heard: 'renewl', id: 'e-ren', minBand: 'provisional' }, // dropped vowel
  ]
  for (const c of cases) {
    const r = resolveEntity({ heard: { name: c.heard }, candidates: corpus, now: NOW })
    assert.equal(r.match?.id, c.id, `"${c.heard}" → ${c.id} (got ${r.match?.id} @ ${r.score.toFixed(3)} ${r.band})`)
    if (c.minBand === 'auto') assert.equal(r.band, 'auto', `"${c.heard}" expected auto, got ${r.band} @ ${r.score.toFixed(3)}`)
    else assert.notEqual(r.band, 'new', `"${c.heard}" should link, got new @ ${r.score.toFixed(3)}`)
  }
})

test('no plausible candidate → new provisional entity (band new, no match)', () => {
  const r = resolveEntity({ heard: { name: 'Marcus Webb' }, candidates: [dana, github, renewal], now: NOW })
  assert.equal(r.match, undefined)
  assert.equal(r.band, 'new')
  assert.ok(r.score < DEFAULT_RESOLVER_CONFIG.provisionalBand)
})

test('two distinct people sharing a first name do NOT merge', () => {
  const rivera = ent({ id: 'e-riv', kind: 'person', name: 'Sam Rivera' })
  const r = resolveEntity({ heard: { name: 'Sam Lee' }, candidates: [rivera], now: NOW })
  assert.equal(r.band, 'new')
  assert.equal(r.match, undefined)
})

test('a plausible rival within Δ marks the resolution ambiguous (auto → reviewable)', () => {
  // Two artifacts whose names are near-identical to the heard form ⇒ a tight rival.
  const a = ent({ id: 'e-a', kind: 'artifact', name: 'apollo' })
  const b = ent({ id: 'e-b', kind: 'artifact', name: 'apollo' }) // deliberate near-tie
  const r = resolveEntity({ heard: { name: 'apollo' }, candidates: [a, b], now: NOW })
  assert.ok(r.match, 'links to one of them')
  assert.equal(r.ambiguous, true)
  assert.ok(r.rival, 'names the rival')
  assert.ok((r.margin ?? 1) <= DEFAULT_RESOLVER_CONFIG.ambiguityMargin)
})

test('a clear winner over a weak also-ran is NOT ambiguous', () => {
  const strong = ent({ id: 'e-strong', kind: 'artifact', name: 'kubernetes' })
  const weak = ent({ id: 'e-weak', kind: 'artifact', name: 'kafka' })
  const r = resolveEntity({ heard: { name: 'kubernetes' }, candidates: [strong, weak], now: NOW })
  assert.equal(r.match?.id, 'e-strong')
  assert.equal(r.ambiguous, false)
})

test('stored heardAs variants are part of the match corpus', () => {
  const repo = ent({ id: 'e-repo', kind: 'artifact', name: 'pi.dev', heardAs: [{ text: 'pie dev' }] })
  // Now the previously-noisy form is an exact hit against the learned variant.
  assert.equal(phoneticFuzzy({ name: 'pie dev' }, repo), 1)
  const r = resolveEntity({ heard: { name: 'pie dev' }, candidates: [repo], now: NOW })
  assert.equal(r.band, 'auto')
})

test('corpusPrior only boosts (>=1), saturates, and is neutral for a fresh entity', () => {
  const fresh = ent({ id: 'e-f', kind: 'topic', name: 'x', mentions: 0 })
  const established = ent({ id: 'e-e', kind: 'topic', name: 'x', mentions: 50, lastSeen: NOW.toISOString() })
  assert.equal(corpusPrior(fresh, NOW), 1)
  const p = corpusPrior(established, NOW)
  assert.ok(p > 1 && p <= 1 + DEFAULT_RESOLVER_CONFIG.establishmentBoost, `prior ${p}`)
})

test('input signals are pass-through multipliers, default neutral 1.0, recorded verbatim', () => {
  const cand = ent({ id: 'e-s', kind: 'topic', name: 'planning' })
  const neutral = resolveEntity({ heard: { name: 'planning' }, candidates: [cand], now: NOW })
  assert.equal(neutral.components.crossSourceCorroboration, 1)
  assert.equal(neutral.components.personAffinity, 1)
  // A weak fuzzy match that corroboration lifts across a band boundary.
  const weakHeard = { name: 'planing' } // dropped 'n'
  const base = resolveEntity({ heard: weakHeard, candidates: [cand], now: NOW })
  const lifted = resolveEntity({ heard: weakHeard, candidates: [cand], now: NOW, signals: { crossSourceCorroboration: 1.2 } })
  assert.ok(lifted.score >= base.score, 'corroboration only raises the score')
  assert.equal(lifted.components.crossSourceCorroboration, 1.2)
})

test('#94 NaN guard: a corrupt lastSeen cannot poison corpusPrior or win the sort with a NaN score', () => {
  // A corrupt DB row: mentions>0 but an unparseable lastSeen. Pre-fix corpusPrior → NaN → NaN score,
  // which (NaN-unstable) could win the sort and persist as a NaN confidence.
  const corrupt = ent({ id: 'e-corrupt', kind: 'topic', name: 'renewal', mentions: 40, lastSeen: 'not-a-date' })
  const prior = corpusPrior(corrupt, NOW)
  assert.ok(Number.isFinite(prior), `corpusPrior finite, got ${prior}`)
  assert.ok(prior >= 1 && prior <= 1 + DEFAULT_RESOLVER_CONFIG.establishmentBoost, `prior in range, got ${prior}`)

  // Exact match to a CLEAN record must still win over the corrupt row; the corrupt score is never NaN.
  const clean = ent({ id: 'e-clean', kind: 'topic', name: 'renewal', mentions: 1, lastSeen: NOW.toISOString() })
  const r = resolveEntity({ heard: { name: 'renewal' }, candidates: [corrupt, clean], now: NOW })
  assert.ok(Number.isFinite(r.score), `resolution score finite, got ${r.score}`)
  assert.ok(r.match !== undefined, 'links, not NaN-drops to new')
  assert.equal(r.band, 'auto')
  // The corrupt row, if it is the winner, still carries a finite score/components (no NaN persists).
  assert.ok(Number.isFinite(r.components.corpusPrior), 'corpusPrior component finite')
})

test('#94 signal clamp: an extreme input multiplier cannot override the phonetic evidence to flip a band', () => {
  // A weak partial (fuzzy ≈0.23) that scores in the NEW band on its own — well below the link floor.
  const cand = ent({ id: 'e-weak', kind: 'topic', name: 'planning' })
  const weakHeard = { name: 'plad' } // phonetic near-miss, fuzzy ≈0.23
  const base = resolveEntity({ heard: weakHeard, candidates: [cand], now: NOW })
  assert.equal(base.band, 'new', `precondition: weak match is a new (got ${base.band} @ ${base.score.toFixed(3)})`)

  // An over-eager producer emits 5× — unclamped that is fuzzy·prior·5 > 1 ⇒ a silent AUTO-link, overriding
  // the phonetic evidence. Clamped to ≤1.5 the score cannot reach even the provisional floor: it stays new.
  const extreme = resolveEntity({ heard: weakHeard, candidates: [cand], now: NOW, signals: { crossSourceCorroboration: 5 } })
  assert.equal(extreme.band, 'new', `clamp holds the band (got ${extreme.band} @ ${extreme.score.toFixed(3)})`)
  assert.equal(extreme.components.crossSourceCorroboration, 1.5, 'multiplier recorded clamped to the documented ceiling')

  // The floor also holds and is recorded: a 0.01 multiplier is lifted to the documented 0.5 floor.
  const exact = resolveEntity({ heard: { name: 'planning' }, candidates: [cand], now: NOW, signals: { personAffinity: 0.01 } })
  assert.equal(exact.components.personAffinity, 0.5, 'clamped to the documented floor')
})

test('rejectedRivalId is honored: a candidate a matching override rejected never wins', () => {
  // The user pinned "Sam" → rivera, rejecting lee. A later "Sam" must not resolve to lee even if lee scores.
  const lee = ent({ id: 'e-lee', kind: 'person', name: 'Sam' })
  const rivera = ent({
    id: 'e-riv',
    kind: 'person',
    name: 'Sam Rivera',
    aliases: ['Sam'],
    overrides: [{ at: '2026-07-10T10:00:00Z', pinnedName: 'Sam', rejectedRivalId: 'e-lee', rejectedRivalName: 'Sam' }],
  })
  const r = resolveEntity({ heard: { name: 'Sam' }, candidates: [lee, rivera], now: NOW })
  assert.equal(r.match?.id, 'e-riv', 'resolves to the pinned entity, not the rejected rival')
})
