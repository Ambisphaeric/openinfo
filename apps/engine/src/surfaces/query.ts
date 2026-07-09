import type { BlockQuery, QueryResult } from '@openinfo/contracts'
import { relevantNow } from '../index/index.js'
import { TeachStore, deriveHintCandidates } from '../teach/index.js'
import type { WorkspaceRegistry } from '../store/index.js'

/** BlockQuery.top has a schema max of 50; the same cap bounds the superset we fetch for truncation. */
const MAX_ROWS = 50

/**
 * Resolve the workspace + session a query runs against from its `params`. A block layout is context-
 * agnostic — it says `session: "current"` (design/renderings/hud-v2.html) and the engine binds that
 * to the workspace's live session at query time, so the SAME document works across sessions. An
 * explicit session id passes through; no session param ⇒ the whole workspace. `workspace` defaults
 * to `default` (single-workspace v0).
 */
const resolveScope = (store: WorkspaceRegistry, params: BlockQuery['params']): { workspaceId: string; sessionId?: string } => {
  const workspaceId = typeof params['workspace'] === 'string' ? params['workspace'] : 'default'
  const sessionParam = params['session']
  if (sessionParam === 'current') {
    const live = store.liveSession(workspaceId)
    return live ? { workspaceId, sessionId: live.id } : { workspaceId }
  }
  if (typeof sessionParam === 'string' && sessionParam.length > 0) return { workspaceId, sessionId: sessionParam }
  return { workspaceId }
}

/**
 * Compile a BlockQuery to store calls — the Phase-0 decision (surface.ts): the declarative JSON
 * pipeline is compiled server-side so a custom block can never express what the engine wouldn't
 * allow. Sources whose backing store exists (relevant-now, moments, sessions, entities, pins)
 * hydrate; `ledger`'s store lands later (P4) so it returns `[]` with documented semantics, NOT an
 * error — a HUD composing a ledger block before P4 shows an empty, explainable block. `top` bounds
 * the returned rows; `truncated` reports whether more existed (HUD shows top-K, workbench holds rest).
 * Reads exclusively through store/ (the DB-handle rule); an unknown workspace reads as [].
 */
export const compileQuery = (store: WorkspaceRegistry, query: BlockQuery, now: Date = new Date()): QueryResult => {
  const { workspaceId, sessionId } = resolveScope(store, query.params)
  const known = store.all().some((ws) => ws.id === workspaceId)
  const top = query.top

  const cap = <T>(rows: T[]): QueryResult => ({
    source: query.source,
    items: top !== undefined ? rows.slice(0, top) : rows,
    ...(top !== undefined ? { top } : {}),
    truncated: top !== undefined && rows.length > top,
  })

  switch (query.source) {
    case 'relevant-now':
      return cap(known ? relevantNow(store, workspaceId, { ...(sessionId !== undefined ? { sessionId } : {}), limit: MAX_ROWS, now }) : [])
    case 'moments': {
      const moments = known ? store.listMoments(workspaceId, sessionId) : []
      // store returns moments oldest-first (by `at`); the stream reads newest-first (hud-v2.html).
      return cap([...moments].sort((a, b) => b.at.localeCompare(a.at)))
    }
    case 'sessions':
      return cap(known ? store.listSessions(workspaceId) : [])
    case 'entities':
      return cap(known ? store.listEntities(workspaceId) : [])
    case 'pins':
      // Pinned canon (P4D): workspace-level records, most-recently-created first (listPins mirrors
      // listEntities — unknown workspace reads as [], never an error).
      return cap(known ? store.listPins(workspaceId) : [])
    case 'todos': {
      // Accumulated follow-ups (task-extract, P4): the to-do documents live in the global _meta.db
      // keyed by session; the store filters them to the resolved workspace (and session, when the
      // block says `session: current`). Flatten each list to its ITEMS — one row per follow-up with
      // its `done` status + provenance why-line — in accumulation order (the running-list order the
      // draft's `{{todo}}` also reads). NOT gated by `known`: unlike the per-workspace record sources,
      // a to-do document exists without a workspace DB (PUT /todos writes the document, not a
      // workspace), and listTodos filters by the body's workspaceId — an unknown workspace / no
      // extraction yet already reads as [], explainable-empty, never an error.
      return cap(store.listTodos(workspaceId, sessionId).flatMap((list) => list.items))
    }
    case 'drafts': {
      // Prepared follow-up drafts (Act pass, P2): workspace-level records in the workspace DB, so this
      // mirrors the record sources — `known`-gated (unknown workspace ⇒ [], never an error), scoped to a
      // session when the block says so. listDrafts returns them oldest-first (creation order); the HUD
      // wants the freshest prepared draft on top, so reverse to newest-first (like moments/pins) before
      // `cap` takes top-K. Each row is a Draft — body + provenance/why-line — rendered client-side.
      const drafts = known ? store.listDrafts(workspaceId, sessionId) : []
      return cap([...drafts].reverse())
    }
    case 'teach': {
      // SUGGESTED attribution-hint candidates (teach loop, P4D): the review half of the flywheel. The
      // candidates are DERIVED read-only from the stored `teach-signals` documents (deriveHintCandidates
      // over TeachStore.list) — the exact derivation GET /teach/candidates serves, so a teach block on a
      // panel renders the same inspectable, citable candidates the review surface would. Workspace-scoped
      // only (a candidate teaches the workspace it was corrected TO — no session dimension). NOT gated by
      // `known`: like todos, the teach signals are DOCUMENTS keyed by workspace (global _meta.db, not a
      // workspace DB), and TeachStore.list reads [] for a workspace with no recorded corrections — an
      // unknown workspace / no reroutes yet reads as [], explainable-empty, never an error. The candidates
      // are already sorted by support desc (deterministic); `cap` takes top-K. Never auto-applied — the
      // loop SUGGESTS, the user reviews and PUTs the pattern (the accept write path is the action-verbs slice).
      return cap(deriveHintCandidates(new TeachStore(store).list(workspaceId)))
    }
    case 'ledger':
      // Backing store not built yet (ledger P4): empty, explainable, not an error.
      return cap([])
    default:
      return cap([])
  }
}
