import type { Entity } from '@openinfo/contracts'

/**
 * Recency×frequency ranking (Index v0) — the first two factors of the ARCHITECTURE §5 live-ranking
 * formula (`score = match(live stream) × recency × frequency × person-affinity`). `match` and
 * `person-affinity` need the live stream and person identity, which arrive with later phases; v0
 * ranks what the single-workspace index already knows.
 *
 *   score = (1 + log2(mentions)) × 0.5^(ageHours / halfLifeHours)
 *
 * - **frequency** is log-damped so a runaway topic (mentioned 40×) cannot drown everything else;
 *   doubling mentions adds a constant step rather than doubling the score.
 * - **recency** is exponential half-life decay on `lastSeen`: an entity untouched for one half-life
 *   is worth half its frequency weight. Default half-life 4h ≈ "this working session".
 *
 * Tuning knobs (constants below, exported and overridable per call). They are deliberately NOT a
 * versioned config document yet: nothing user-facing reads or edits ranking in v0 — the HUD
 * relevant-now block and its query DSL (`join(live, index).top(4)`) land later, and that block
 * document is the natural home for user-tunable ranking. Revisit note in PHASE2-NOTES.
 */
export interface RankConfig {
  /** hours for the recency weight to halve; smaller = "now" dominates harder */
  halfLifeHours: number
}

export const DEFAULT_RANK_CONFIG: RankConfig = { halfLifeHours: 4 }

const MS_PER_HOUR = 3_600_000

/** Pure per-entity score at time `now`. Entities never seen (mentions 0/undefined) score by recency alone. */
export const scoreEntity = (entity: Entity, now: Date, config: RankConfig = DEFAULT_RANK_CONFIG): number => {
  const mentions = Math.max(1, entity.mentions ?? 1)
  const frequency = 1 + Math.log2(mentions)
  const ageHours = Math.max(0, now.getTime() - new Date(entity.lastSeen).getTime()) / MS_PER_HOUR
  const recency = 0.5 ** (ageHours / config.halfLifeHours)
  return frequency * recency
}

export interface RankedEntity {
  entity: Entity
  score: number
}

/**
 * Rank entities by recency×frequency, descending. Ties break on more-recent `lastSeen`, then name
 * (ascending) so the order is deterministic. Pure — takes `now` explicitly.
 */
export const rankEntities = (
  entities: readonly Entity[],
  now: Date,
  config: RankConfig = DEFAULT_RANK_CONFIG,
): RankedEntity[] =>
  entities
    .map((entity) => ({ entity, score: scoreEntity(entity, now, config) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.entity.lastSeen.localeCompare(a.entity.lastSeen) ||
        a.entity.name.localeCompare(b.entity.name),
    )
