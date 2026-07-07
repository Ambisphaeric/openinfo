import type { Moment, RelevantEntity } from '@openinfo/contracts'
import type { WorkspaceRegistry } from '../store/index.js'
import { rankEntities, DEFAULT_RANK_CONFIG, type RankConfig } from './rank.js'

export interface RelevantNowOptions {
  /** narrow to entities referenced by this session's moments (and join only those moments) */
  sessionId?: string
  /** max entities returned (default 10) */
  limit?: number
  /** max joined moments per entity, most recent first (default 5) */
  momentsPerEntity?: number
  now?: Date
  rank?: RankConfig
}

/**
 * The relevant-now join (Index v0): "which entities matter right now" for a workspace. Ranks the
 * workspace's entities by recency×frequency (rank.ts) and joins each with the recent moments that
 * reference it (via Moment.refs / Entity.momentRefs, written by the same distill pass), so a noisy
 * entity is inspectable — every row carries the moments and provenance that put it there.
 *
 * Session scoping: with `sessionId`, only entities referenced by that session's moments qualify,
 * and only that session's moments are joined. Reads exclusively through store/ (the DB-handle rule).
 * An unknown workspace reads as [], not an error (mirrors GET /moments).
 */
export const relevantNow = (store: WorkspaceRegistry, workspaceId: string, opts: RelevantNowOptions = {}): RelevantEntity[] => {
  if (!store.all().some((ws) => ws.id === workspaceId)) return []
  const limit = opts.limit ?? 10
  const momentsPerEntity = opts.momentsPerEntity ?? 5
  const now = opts.now ?? new Date()

  const moments = opts.sessionId !== undefined ? store.listMoments(workspaceId, opts.sessionId) : store.listMoments(workspaceId)
  const byId = new Map(moments.map((moment) => [moment.id, moment]))

  let entities = store.listEntities(workspaceId)
  if (opts.sessionId !== undefined) {
    entities = entities.filter((entity) => entity.momentRefs.some((id) => byId.has(id)))
  }

  return rankEntities(entities, now, opts.rank ?? DEFAULT_RANK_CONFIG)
    .slice(0, limit)
    .map(({ entity, score }) => ({
      entity,
      score,
      moments: entity.momentRefs
        .map((id) => byId.get(id))
        .filter((moment): moment is Moment => moment !== undefined)
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, momentsPerEntity),
    }))
}
