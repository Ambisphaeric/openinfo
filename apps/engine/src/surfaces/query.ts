import type { BlockQuery, QueryResult, QueueStatus, SenseLaneSnapshot, TranscriptInspector } from '@openinfo/contracts'
import type { SenseGateChain } from './settings/sense-gates.js'
import { relevantNow } from '../index/index.js'
import { FieldValueStore } from '../distill/index.js'
import { TeachStore, deriveHintCandidates } from '../teach/index.js'
import type { WorkspaceRegistry } from '../store/index.js'
import { ItemSignalStore } from './signals.js'

/** BlockQuery.top has a schema max of 50; the same cap bounds the superset we fetch for truncation. */
const MAX_ROWS = 50

/**
 * Non-store data a query arm needs, injected by the caller (POST /query). Most sources read exclusively
 * through store/ (the DB-handle rule), but the `queue` source is OPERATIONAL ENGINE STATE — the live
 * backlog/ETA/last-failure the CaptureQueue holds in memory (spool.ts), NOT a store record — so the route
 * hands its `status()` snapshot in here rather than compileQuery reaching for the queue itself. Absent (a
 * unit test, or a non-queue query) ⇒ the `queue` arm reads [], explainable-empty.
 */
export interface QuerySources {
  queueStatus?: QueueStatus
  /**
   * The transcription-inspector snapshot for the `transcript` source (#101) — recent ephemeral transcript
   * chunks (the in-memory ring) plus the CURRENT stt slot config. Like `queueStatus`, this is operational/
   * config engine state, NOT a store record, so the /query route builds it (from the TranscriptRing + the
   * live fabric) and injects it here. Absent (a unit test, or a non-transcript query) ⇒ the arm reads [].
   */
  transcript?: TranscriptInspector
  /**
   * The per-sense gate chains for the `senses` source (#7/#101) — the SAME verdict GET /senses computes,
   * evaluated by the route from the live flags/fabric/last-failure and injected here. Computed state, not a
   * store record. Absent (a unit test, or a non-senses query) ⇒ the arm reads [], explainable-empty.
   */
  senseGates?: SenseGateChain[]
  /**
   * The process-local, metadata-only physical-lane rows for `live-senses` (#174). These are the SAME
   * canonical mic/system-audio/screen snapshots GET /senses/live serves, resolved and injected by the
   * route because the tracker is runtime state, not a persisted store. Absent ⇒ explainable-empty.
   */
  liveSenses?: SenseLaneSnapshot[]
}

/** The resolved scope of a query: its workspace, an optional session filter, and the honest #210 flag. */
export interface QueryScope {
  workspaceId: string
  sessionId?: string
  /**
   * True ⇒ the block asked for `session: 'current'` but NO session is live this process (#210). The scope
   * deliberately carries NO sessionId AND this flag rather than silently widening to the whole workspace:
   * a session-scoped source must read honest-empty ("nothing captured yet"), never the previous session's
   * records rendered as current. Distinct from an ABSENT session param (a block that legitimately reads all
   * workspace history), which sets neither field — so an all-history block is unchanged.
   */
  noCurrentSession?: boolean
}

/**
 * Resolve the workspace + session a query runs against from its `params`. A block layout is context-
 * agnostic — it says `session: "current"` (design/renderings/hud-v2.html) and the engine binds that
 * to the live session at query time, so the SAME document works across sessions. An explicit session id
 * passes through; no session param ⇒ the whole workspace.
 *
 * HONEST DISPLAY SCOPE (#210): `current` binds to the RUNTIME-current session resolved by `currentSessionId`
 * — the SAME authority the live sense lanes use (SenseLaneTracker.currentSessionId), NOT store.liveSession's
 * persisted most-recent-unended session. Engine sessions outlive the client, so a stale unended session from
 * a prior process must not hydrate as current. When there is no live session (or, for a unit caller, no
 * resolver was supplied) the scope is flagged `noCurrentSession` and carries no sessionId — it NEVER silently
 * falls back to whole-workspace history, which is the daily-felt "lingering records from a previous session".
 *
 * WORKSPACE RESOLUTION (#99): an explicit per-block `params.workspace` ALWAYS wins. Absent, the workspace
 * falls back to `defaultWorkspaceId` — the binding of the app INSTANCE this query runs under (the surface's
 * `workspaceId`, resolved by the /query route from `?surface=<id>`). Absent that too, it is `default`
 * (single-workspace v0). So one context-agnostic block document, instantiated for N repos, reads each
 * instance's own silo without editing the block — the per-instance workspace is named on the surface, not
 * baked into every block's params.
 */
export const resolveQueryScope = (
  store: WorkspaceRegistry,
  params: BlockQuery['params'],
  defaultWorkspaceId?: string,
  currentSessionId?: (workspaceId: string) => string | undefined,
): QueryScope => {
  const workspaceId = typeof params['workspace'] === 'string' ? params['workspace'] : (defaultWorkspaceId ?? 'default')
  const sessionParam = params['session']
  if (sessionParam === 'current') {
    const live = currentSessionId?.(workspaceId)
    return live !== undefined ? { workspaceId, sessionId: live } : { workspaceId, noCurrentSession: true }
  }
  if (typeof sessionParam === 'string' && sessionParam.length > 0) return { workspaceId, sessionId: sessionParam }
  return { workspaceId }
}

/**
 * The sources whose rows are SESSION-SCOPED — they pass `sessionId` to the store and so are the ones that
 * would leak a previous session's content if `session: 'current'` silently widened to whole-workspace. When
 * the scope is `noCurrentSession` (#210) these read empty; the workspace-level sources (sessions, entities,
 * pins, teach) carry no session dimension and were never the stale-content defect, so they are unaffected.
 */
const SESSION_SCOPED_SOURCES = new Set<BlockQuery['source']>(['relevant-now', 'moments', 'todos', 'drafts', 'distillates', 'fields'])

/**
 * Compile a BlockQuery to store calls — the Phase-0 decision (surface.ts): the declarative JSON
 * pipeline is compiled server-side so a custom block can never express what the engine wouldn't
 * allow. Sources whose backing store exists (relevant-now, moments, sessions, entities, pins)
 * hydrate; `ledger`'s store lands later (P4) so it returns `[]` with documented semantics, NOT an
 * error — a HUD composing a ledger block before P4 shows an empty, explainable block. `top` bounds
 * the returned rows; `truncated` reports whether more existed (HUD shows top-K, workbench holds rest).
 * Reads exclusively through store/ (the DB-handle rule), with ONE documented exception: the `queue`
 * source is operational engine state (spool.ts), not a store record, so the route injects its snapshot
 * via `sources` (see QuerySources). An unknown workspace reads as [].
 */
export const compileQuery = (
  store: WorkspaceRegistry,
  query: BlockQuery,
  now: Date = new Date(),
  sources: QuerySources = {},
  defaultWorkspaceId?: string,
  currentSessionId?: (workspaceId: string) => string | undefined,
): QueryResult => {
  const { workspaceId, sessionId, noCurrentSession } = resolveQueryScope(store, query.params, defaultWorkspaceId, currentSessionId)
  const known = store.all().some((ws) => ws.id === workspaceId)
  const top = query.top

  // Suppression (#66): the `${source}:${itemId}` keys this workspace has DISMISSED, honored below so a
  // dismissed row stays gone across reloads. Read once (empty ⇒ the filter is a no-op). The signal store
  // is a document store over _meta.db, so it is constructed ad-hoc here exactly as the teach arm does.
  const dismissed = new ItemSignalStore(store).dismissedKeys(workspaceId)

  const cap = <T>(rows: T[], suppressed = 0, noSession = false): QueryResult => ({
    source: query.source,
    items: top !== undefined ? rows.slice(0, top) : rows,
    ...(top !== undefined ? { top } : {}),
    truncated: top !== undefined && rows.length > top,
    // Disclosed, not mysterious: a block emptied purely by suppression can say "N dismissed" (#66).
    ...(suppressed > 0 ? { suppressed } : {}),
    // Honest empty-scope disclosure (#215): a session-scoped source that read empty ONLY because no session
    // is live this process (#210) says so, so the block distinguishes "no session running" from "live but
    // nothing captured yet". Present only when true, additive — existing consumers are unaffected.
    ...(noSession ? { noCurrentSession: true } : {}),
  })

  /**
   * Drop the rows this workspace dismissed (matched by the source's stable id), then cap. `idOf` reads the
   * id the dismiss glyph recorded — a top-level `id` for most sources, `entity.id` for the relevant-now join.
   * The suppressed COUNT rides through to the QueryResult so the client can disclose an all-suppressed empty.
   */
  const capSuppressed = <T>(rows: T[], idOf: (row: T) => string | undefined): QueryResult => {
    if (dismissed.size === 0) return cap(rows)
    let suppressed = 0
    const kept = rows.filter((row) => {
      const id = idOf(row)
      if (id !== undefined && dismissed.has(`${query.source}:${id}`)) {
        suppressed += 1
        return false
      }
      return true
    })
    return cap(kept, suppressed)
  }

  // Honest display scope (#210): a `session: 'current'` read with no live session must never widen to the
  // whole workspace. A session-scoped source reads empty ("nothing captured yet") instead of the previous
  // session's records — the SAME posture the live sense lanes already take on a fresh process. Placed before
  // the switch so it uniformly covers every session-scoped arm without threading the flag into each store call.
  if (noCurrentSession && SESSION_SCOPED_SOURCES.has(query.source)) return cap([], 0, true)

  switch (query.source) {
    case 'relevant-now':
      return capSuppressed(
        known ? relevantNow(store, workspaceId, { ...(sessionId !== undefined ? { sessionId } : {}), limit: MAX_ROWS, now }) : [],
        (row) => row.entity.id,
      )
    case 'moments': {
      const moments = known ? store.listMoments(workspaceId, sessionId) : []
      // store returns moments oldest-first (by `at`); the stream reads newest-first (hud-v2.html).
      return capSuppressed([...moments].sort((a, b) => b.at.localeCompare(a.at)), (m) => m.id)
    }
    case 'sessions':
      return cap(known ? store.listSessions(workspaceId) : [])
    case 'entities':
      return capSuppressed(known ? store.listEntities(workspaceId) : [], (e) => e.id)
    case 'pins':
      // Pinned canon (P4D): workspace-level records, most-recently-created first (listPins mirrors
      // listEntities — unknown workspace reads as [], never an error).
      return capSuppressed(known ? store.listPins(workspaceId) : [], (p) => p.id)
    case 'todos': {
      // Accumulated follow-ups (task-extract, P4): the to-do documents live in the global _meta.db
      // keyed by session; the store filters them to the resolved workspace (and session, when the
      // block says `session: current`). Flatten each list to its ITEMS — one row per follow-up with
      // its `done` status + provenance why-line — in accumulation order (the running-list order the
      // draft's `{{todo}}` also reads). NOT gated by `known`: unlike the per-workspace record sources,
      // a to-do document exists without a workspace DB (PUT /todos writes the document, not a
      // workspace), and listTodos filters by the body's workspaceId — an unknown workspace / no
      // extraction yet already reads as [], explainable-empty, never an error.
      return capSuppressed(store.listTodos(workspaceId, sessionId).flatMap((list) => list.items), (item) => item.id)
    }
    case 'drafts': {
      // Prepared follow-up drafts (Act pass, P2): workspace-level records in the workspace DB, so this
      // mirrors the record sources — `known`-gated (unknown workspace ⇒ [], never an error), scoped to a
      // session when the block says so. listDrafts returns them oldest-first (creation order); the HUD
      // wants the freshest prepared draft on top, so reverse to newest-first (like moments/pins) before
      // `cap` takes top-K. Each row is a Draft — body + provenance/why-line — rendered client-side.
      const drafts = known ? store.listDrafts(workspaceId, sessionId) : []
      return capSuppressed([...drafts].reverse(), (d) => d.id)
    }
    case 'queue': {
      // Honest backlog telemetry (P4A queue): the per-kind depth, ETA, overflow state, and last drain
      // failure the CaptureQueue serves over GET /queue. UNLIKE every other source, this is NOT a store
      // record — it is operational engine state the queue holds in memory (spool.ts: lastFailure/samples
      // are ephemeral runtime facts, deliberately not documents), so it is INJECTED via `sources` by the
      // /query route (which awaits ctx.queue.status()) rather than read through store/. One row: the whole
      // QueueStatus snapshot, rendered client-side as a status panel (per-kind backlog + ETA + overflow +
      // the last-failure line, prominently). No status injected (a unit test, or the queue unwired) ⇒ [],
      // explainable-empty — never an error. Workspace/session params don't scope it: the spool is global.
      return cap(sources.queueStatus !== undefined ? [sources.queueStatus] : [])
    }
    case 'distillates': {
      // The distillate stream (Distill pass, P2): the merge-window summaries — one row per distilled
      // window of raw capture. This is the persisted, queryable substance of the "transcript/distillate
      // stream" (#12): raw pre-distill transcripts are transient (the stt stage rewrites audio chunks to
      // text IN-FLIGHT with no persistence path — see api/http.ts — so there is nothing durable to query
      // for the raw transcript), whereas distillates are workspace-DB records. So this mirrors the record
      // sources — `known`-gated (unknown workspace ⇒ [], never an error), session-scopable. listDistillates
      // returns them oldest-first (creation order); the stream reads NEWEST-first (mirroring the moments
      // arm's ordering — hud-v2.html's stream), so reverse before `cap` takes top-K. Each row is a
      // Distillate — window text + timestamp + endpoint provenance — rendered client-side.
      const distillates = known ? store.listDistillates(workspaceId, sessionId) : []
      return capSuppressed([...distillates].reverse(), (d) => d.id)
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
    case 'fields': {
      // Fast fields (#61): the latest value of each fast field, produced by the fan-out scheduler and
      // persisted per (workspace, session?, fieldId). Each row is a FieldValue carrying the model output
      // PLUS full provenance (templateId · endpoint · model) so a block renders a why-line, and the #66
      // `state: 'provisional'` micro-state carrier (fast results are provisional by definition — the
      // confirm judge is a later issue). NOT gated by `known`: like todos/teach, field values are DOCUMENTS
      // keyed by workspace/session (global _meta.db, not a workspace DB), so an unknown workspace / no
      // fields produced yet reads as [], explainable-empty, never an error. A session-scoped query returns
      // that session's fields plus the workspace-scoped ones (FieldValueStore.list). Freshest first.
      const values = new FieldValueStore(store).list(workspaceId, sessionId)
      return capSuppressed([...values].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), (v) => v.fieldId)
    }
    case 'transcript':
      // The transcription inspector (#101): the diagnostics app's headline. UNLIKE the record sources this
      // is NOT a store record — it is the recent ephemeral transcript ring + the current stt slot config,
      // built and INJECTED by the /query route (the `queue` pattern). One row: the whole TranscriptInspector
      // snapshot, rendered client-side (chunk rows + the stt-slot line + the disclosed #65 per-chunk gap).
      // Not injected (a unit caller) ⇒ [], explainable-empty — never an error. Workspace/session params
      // don't scope it: the ring is process-global (a debugging glance, disclosed as last-N, not persisted).
      return cap(sources.transcript !== undefined ? [sources.transcript] : [])
    case 'senses':
      // The sense-gate chains (#7 on a diagnostics surface, #101): the SAME per-sense "what is blocking this
      // sense" verdict GET /senses serves, evaluated by the route from live flags/fabric/last-failure and
      // injected here (computed state, not a store record). One row per sense; the block renders the first
      // blocking gate + its fix, or all-pass. Not injected (a unit caller) ⇒ [], explainable-empty.
      return cap(sources.senseGates ?? [])
    case 'live-senses':
      // The composable HUD view of runtime capture truth (#174): exactly the metadata rows the process-
      // local SenseLaneTracker owns, injected by POST /query after resolving the block/app-instance scope.
      // No captured bytes, transcript/OCR text, endpoint material, or arbitrary errors can enter this
      // source because every row is the existing closed SenseLaneSnapshot contract. The tracker supplies
      // canonical mic → system-audio → screen order; cap preserves it. No injection ⇒ [], never invented
      // persisted truth from an old unended session.
      return cap(sources.liveSenses ?? [])
    case 'ledger':
      // Backing store not built yet (ledger P4): empty, explainable, not an error.
      return cap([])
    default:
      return cap([])
  }
}
