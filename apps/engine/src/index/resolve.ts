import type { Entity } from '@openinfo/contracts'
import { nameSimilarity, normalizeForm } from './phonetic.js'

/**
 * The scored entity resolver (#72). Replaces exact normalized-string equality with a blended score so an
 * entity heard through imperfect ASR ("pie dev" for a repo named `pi.dev`) can still find its record:
 *
 *     score = phoneticFuzzy(heard, record) × corpusPrior × crossSourceCorroboration × personAffinity
 *
 * DETERMINISTIC ENGINE CODE — the model extracts candidate strings; this decides where they land. Pure and
 * fixture-driven: `resolveEntity` takes the heard mention, the same-kind candidate records, and `now`, and
 * returns a decision the store records. It NEVER opens a DB or calls a model.
 *
 * Factors:
 *  - `phoneticFuzzy` ∈ [0,1] — the MAX over (heard name/aliases) × (record name/aliases/heardAs) of
 *    `nameSimilarity` (double-metaphone + edit + token/substring; see phonetic.ts). The record's stored
 *    `heardAs[]` variants ARE part of the match corpus, so a fuzzy match that once resolved noisily gets
 *    easier to hit again (the store writes the heard form back on a successful match).
 *  - `corpusPrior` ∈ [1, 1+establishmentBoost] — how ESTABLISHED the entity is (sighting/mention count ×
 *    recency). It ONLY boosts (never penalizes) and is deliberately bounded small, so an established
 *    entity edges out an equally-fuzzy stranger WITHOUT the prior ever dragging an exact match below the
 *    auto band or shoving a weak partial across a band boundary. Neutral 1.0 for a fresh record.
 *  - `crossSourceCorroboration` / `personAffinity` — INPUT MULTIPLIERS, default the neutral 1.0. #74's
 *    cross-sense correlator and a real entity graph will feed them; NO producer feeds them today, so they
 *    are honestly left at 1.0 (never fabricated). The parameter seam is typed + documented so wiring a
 *    producer later is a one-line pass-through.
 *
 * Bands (on the final, clamped score):
 *  - `≥ autoBand` (~0.85) → auto-link, SILENT — unless a rival makes it ambiguous (below).
 *  - `provisionalBand ≤ score < autoBand` (~0.5–0.85) → provisional link, rendered as a #66 provisional
 *    micro-state.
 *  - `< provisionalBand` → no candidate crossed the link floor ⇒ resolve to a NEW (provisional) entity.
 *
 * Ambiguity: if a plausible RIVAL (itself ≥ provisionalBand) scored within `ambiguityMargin` of the winner,
 * the resolution is `ambiguous` — a silent auto-link is DOWNGRADED to a reviewable provisional one, and the
 * rival is named so the clarify affordance (#75) can key off it.
 */

export type ResolutionBand = 'auto' | 'provisional' | 'new'

/** The heard mention to resolve — the model-extracted surface form plus any aliases it offered. */
export interface HeardMention {
  name: string
  aliases?: readonly string[]
}

/**
 * The two not-yet-produced signals, taken as INPUT MULTIPLIERS (default neutral 1.0). Disclosed honestly:
 * nothing feeds these yet — #74's correlator writes `crossSourceCorroboration`, a real entity graph writes
 * `personAffinity`. Kept as typed inputs so the resolver's contract is stable before the producers exist.
 */
export interface ResolutionSignals {
  /** #74: same concept corroborated via another sense in the window. ≥1 boosts. Default 1.0. */
  crossSourceCorroboration?: number
  /** speaker/participant adjacency to the entity graph. ≥1 boosts. Default 1.0. */
  personAffinity?: number
}

export interface ResolverConfig {
  /** score ≥ this ⇒ auto band (silent link). */
  autoBand: number
  /** score ≥ this (and < autoBand) ⇒ provisional link; below ⇒ new entity. */
  provisionalBand: number
  /** a rival (itself ≥ provisionalBand) within this gap of the winner marks the resolution ambiguous. */
  ambiguityMargin: number
  /** the maximum establishment boost corpusPrior can add (bounded so it never crosses a band boundary alone). */
  establishmentBoost: number
  /** mentions at which the establishment boost effectively saturates. */
  establishmentSaturation: number
  /** half-life (hours) for the recency half of corpusPrior. */
  halfLifeHours: number
}

export const DEFAULT_RESOLVER_CONFIG: ResolverConfig = {
  autoBand: 0.85,
  provisionalBand: 0.5,
  ambiguityMargin: 0.05,
  establishmentBoost: 0.1,
  establishmentSaturation: 32,
  halfLifeHours: 24 * 7,
}

const MS_PER_HOUR = 3_600_000

/** The four multiplicands recorded verbatim on every resolution so the score is reproducible. */
export interface ResolutionComponents {
  phoneticFuzzy: number
  corpusPrior: number
  crossSourceCorroboration: number
  personAffinity: number
}

export interface ScoredCandidate {
  entity: Entity
  score: number
  phoneticFuzzy: number
  corpusPrior: number
}

export interface Resolution {
  /** the winning candidate to LINK to; undefined ⇒ band 'new' (create a fresh record). */
  match?: Entity
  score: number
  band: ResolutionBand
  ambiguous: boolean
  components: ResolutionComponents
  /** the plausible runner-up, when one scored ≥ provisionalBand. */
  rival?: { entity: Entity; score: number }
  /** winner score − rival score (present when a rival is present). */
  margin?: number
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n))

/**
 * The corpus prior — how established this entity is. Establishment climbs with mention/sighting count
 * (log-damped, saturating) and is softened (never zeroed) by recency decay on `lastSeen`. Returns a
 * multiplier in [1, 1+establishmentBoost]; ONLY boosts, so it can never pull an exact match below auto.
 */
export const corpusPrior = (entity: Entity, now: Date, config: ResolverConfig = DEFAULT_RESOLVER_CONFIG): number => {
  const mentions = Math.max(0, entity.mentions ?? entity.sightings?.length ?? 0)
  if (mentions <= 0) return 1
  const established = Math.min(1, Math.log2(1 + mentions) / Math.log2(1 + config.establishmentSaturation))
  const ageHours = Math.max(0, now.getTime() - new Date(entity.lastSeen).getTime()) / MS_PER_HOUR
  const recency = 0.5 ** (ageHours / config.halfLifeHours) // 1 (just now) → 0 (long ago)
  const weight = established * (0.5 + 0.5 * recency) // recency never zeroes an established entity
  return 1 + config.establishmentBoost * weight
}

/** All surface forms a heard mention can match on: its name + any aliases the model offered. */
const heardForms = (heard: HeardMention): string[] =>
  [heard.name, ...(heard.aliases ?? [])].map((f) => f.trim()).filter((f) => f.length > 0)

/** All surface forms a record can be matched BY: its name, aliases, and stored heardAs variants. */
const recordForms = (entity: Entity): string[] => {
  const forms = [entity.name, ...entity.aliases]
  for (const h of entity.heardAs ?? []) forms.push(h.text)
  return forms.map((f) => f.trim()).filter((f) => f.length > 0)
}

/** phoneticFuzzy(heard, record): the strongest similarity across every heard-form × record-form pair. */
export const phoneticFuzzy = (heard: HeardMention, entity: Entity): number => {
  const hs = heardForms(heard)
  const rs = recordForms(entity)
  let best = 0
  for (const h of hs) {
    for (const r of rs) {
      const sim = nameSimilarity(h, r)
      if (sim > best) best = sim
      if (best >= 1) return 1
    }
  }
  return best
}

/**
 * Score ONE candidate against the heard mention. Exposed for inspection/tests. `rejectedIds` are records a
 * sovereign override for this exact surface form already rejected — they are excluded from winning (honors
 * `EntityOverride.rejectedRivalId`: never re-score against a rival the user already settled).
 */
export const scoreCandidate = (
  heard: HeardMention,
  entity: Entity,
  now: Date,
  signals: ResolutionSignals = {},
  config: ResolverConfig = DEFAULT_RESOLVER_CONFIG,
): ScoredCandidate => {
  const fuzzy = phoneticFuzzy(heard, entity)
  const prior = corpusPrior(entity, now, config)
  const cross = signals.crossSourceCorroboration ?? 1
  const affinity = signals.personAffinity ?? 1
  const score = clamp01(fuzzy * prior * cross * affinity)
  return { entity, score, phoneticFuzzy: fuzzy, corpusPrior: prior }
}

/**
 * Resolve a heard mention against same-kind candidates. Pure. The caller (store.upsertEntity) is
 * responsible for the SOVEREIGN override short-circuit (a pinned surface form outranks any score) BEFORE
 * calling this — an overridden mapping never reaches the scorer. Here we additionally honor
 * `rejectedRivalId`: any candidate a matching override already rejected is dropped from contention.
 */
export const resolveEntity = (input: {
  heard: HeardMention
  candidates: readonly Entity[]
  now: Date
  signals?: ResolutionSignals
  config?: ResolverConfig
}): Resolution => {
  const config = input.config ?? DEFAULT_RESOLVER_CONFIG
  const signals = input.signals ?? {}
  const cross = signals.crossSourceCorroboration ?? 1
  const affinity = signals.personAffinity ?? 1

  // Honor rejectedRivalId: a candidate that a user override (pinning ANY of the heard forms) already
  // rejected must never win — the user settled that question.
  const heardKeys = new Set(heardForms(input.heard).map(normalizeForm))
  const rejected = new Set<string>()
  for (const cand of input.candidates) {
    for (const o of cand.overrides ?? []) {
      if (o.pinnedName !== undefined && heardKeys.has(normalizeForm(o.pinnedName)) && o.rejectedRivalId !== undefined) {
        rejected.add(o.rejectedRivalId)
      }
    }
  }

  const scored = input.candidates
    .filter((c) => !rejected.has(c.id))
    .map((c) => scoreCandidate(input.heard, c, input.now, signals, config))
    .sort((a, b) => b.score - a.score || b.entity.lastSeen.localeCompare(a.entity.lastSeen) || a.entity.name.localeCompare(b.entity.name))

  const winner = scored[0]
  const runnerUp = scored[1]

  const neutralComponents: ResolutionComponents = {
    phoneticFuzzy: winner?.phoneticFuzzy ?? 0,
    corpusPrior: winner?.corpusPrior ?? 1,
    crossSourceCorroboration: cross,
    personAffinity: affinity,
  }

  if (!winner || winner.score < config.provisionalBand) {
    // Nothing crossed the link floor → a NEW provisional entity. Still report the best near-miss as context.
    const resolution: Resolution = {
      score: winner?.score ?? 0,
      band: 'new',
      ambiguous: false,
      components: winner ? neutralComponents : { phoneticFuzzy: 0, corpusPrior: 1, crossSourceCorroboration: cross, personAffinity: affinity },
    }
    if (winner) {
      resolution.rival = { entity: winner.entity, score: winner.score }
      resolution.margin = 0
    }
    return resolution
  }

  const band: ResolutionBand = winner.score >= config.autoBand ? 'auto' : 'provisional'
  const hasPlausibleRival = runnerUp !== undefined && runnerUp.score >= config.provisionalBand
  const margin = hasPlausibleRival ? winner.score - runnerUp!.score : undefined
  const ambiguous = hasPlausibleRival && margin! <= config.ambiguityMargin

  const resolution: Resolution = {
    match: winner.entity,
    score: winner.score,
    band,
    ambiguous,
    components: neutralComponents,
  }
  if (hasPlausibleRival) {
    resolution.rival = { entity: runnerUp!.entity, score: runnerUp!.score }
    resolution.margin = margin!
  }
  return resolution
}
