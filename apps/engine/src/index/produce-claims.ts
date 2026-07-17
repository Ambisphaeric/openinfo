import type { WorkspaceRegistry } from '../store/index.js'
import { buildClaims, type ClaimBuildResult } from './claims.js'

/**
 * The LIVE Claim producer (#178 slice 1) — the impure runtime seam that wires the pure builder
 * (`claims.ts`) to the store, so co-occurrence claims materialize during normal capture WITHOUT anyone
 * calling the on-demand POST route. Like `produce-packets.ts`, this is a store-touching index/ seam: it
 * reads a session's already-converged evidence (its ContextPackets + moments), runs the deterministic
 * builder, persists ONLY what the builder appends, and records the attempt's outcome so a failure is
 * VISIBLE, never silently swallowed.
 *
 * CONTAINED FAILURE (non-negotiable): building a claim is derived, best-effort convenience — it must never
 * block or fail the capture/distill/session-end path that produced the evidence. So `materializeClaims`
 * NEVER throws: any error is caught, recorded on the build log with its reason, and returned in the
 * outcome. The session-end seam calls this AFTER the packets are materialized, so the packet-candidate
 * co-occurrence evidence is fresh; a build failure loses nothing but the (rebuildable) derived claim.
 *
 * IDEMPOTENT + BATCHED: the builder is idempotent (same evidence in ⇒ nothing appended), so re-running over
 * a converged session is a safe no-op. It runs ONCE per session end over the whole session — not per
 * observation — so it adds no per-record hot-loop cost. WORKSPACE ISOLATION: every read and the write are
 * scoped to the session's own workspace, never a shared table. NO MODEL: slice 1 is deterministic
 * co-occurrence only; a judge-enrichment pass (semantic relations) is a LATER slice.
 */

/** What triggered a build attempt — the live session-end seam, or the on-demand route. */
export type ClaimBuildTrigger = 'session-end' | 'on-demand'

/**
 * One recorded build attempt — the diagnostics "last update" signal. `error` present ⇒ the build did not
 * finish (created/unchanged are 0) and its reason is carried for display; absent ⇒ the build converged and
 * `created`/`unchanged` say what it did. Process-scoped (cleared on restart), mirroring PacketBuildLog —
 * the durable truth is the claims themselves.
 */
export interface ClaimBuildAttempt {
  workspaceId: string
  sessionId: string
  trigger: ClaimBuildTrigger
  /** ISO instant the attempt ran. */
  at: string
  /** claims appended this attempt (new relationships + supersession revisions). */
  created: number
  /** existing derived heads that rebuilt identical — kept untouched. */
  unchanged: number
  /** present ⇒ the attempt failed; the contained reason, for the diagnostics "last update didn't finish" line. */
  error?: string
}

/**
 * The latest build attempt per (workspace, session), in memory — bounded, latest-only (mirrors
 * PacketBuildLog). Diagnostics reads the most recent attempt so a live-seam failure surfaces as text.
 */
export class ClaimBuildLog {
  private readonly latest = new Map<string, ClaimBuildAttempt>()

  private key(workspaceId: string, sessionId: string): string {
    return `${workspaceId}\u0000${sessionId}`
  }

  /** Record (replacing any prior) the latest attempt for its session. */
  record(attempt: ClaimBuildAttempt): void {
    this.latest.set(this.key(attempt.workspaceId, attempt.sessionId), attempt)
  }

  /** The latest attempt for one session, or undefined when no build has run for it this process. */
  latestFor(workspaceId: string, sessionId: string): ClaimBuildAttempt | undefined {
    return this.latest.get(this.key(workspaceId, sessionId))
  }

  /** Every session's latest attempt in a workspace, newest attempt first — the diagnostics read. */
  recentForWorkspace(workspaceId: string): ClaimBuildAttempt[] {
    return [...this.latest.values()]
      .filter((attempt) => attempt.workspaceId === workspaceId)
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  }
}

export interface MaterializeClaimsScope {
  workspaceId: string
  sessionId: string
  trigger: ClaimBuildTrigger
}

export interface MaterializeClaimsDeps {
  store: WorkspaceRegistry
  /** the diagnostics build log to record the attempt on (optional so the seam is testable without one). */
  log?: ClaimBuildLog
  /** injectable clock for the recorded attempt time and appended claims' createdAt. */
  now?: () => Date
}

/** The builder result plus a contained failure reason (present ⇒ nothing was built or persisted). */
export interface MaterializeClaimsOutcome extends ClaimBuildResult {
  error?: string
}

/**
 * Build (or converge) one session's co-occurrence Claims from its stored evidence and persist what the
 * builder appends. Reads and writes are scoped to `scope.workspaceId`. NEVER throws: a read/build/write
 * failure is caught, recorded on the log with its reason, and returned as `outcome.error`. It reads the
 * session's DERIVED chain (including superseded revisions) so supersession is decided correctly, and never
 * reads or writes sovereign user corrections — those are resolved over the chain at read time.
 */
export const materializeClaims = (deps: MaterializeClaimsDeps, scope: MaterializeClaimsScope): MaterializeClaimsOutcome => {
  const now = deps.now ?? (() => new Date())
  const { workspaceId, sessionId, trigger } = scope
  try {
    const result = buildClaims({
      workspaceId,
      sessionId,
      packets: deps.store.listContextPackets(workspaceId, { sessionId }),
      moments: deps.store.listMoments(workspaceId, sessionId),
      entities: deps.store.listEntities(workspaceId),
      existing: deps.store.listClaims(workspaceId, { sessionId, source: 'derived', includeSuperseded: true }),
      now,
    })
    for (const claim of result.created) deps.store.saveClaim(claim)
    deps.log?.record({ workspaceId, sessionId, trigger, at: now().toISOString(), created: result.created.length, unchanged: result.unchanged.length })
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    deps.log?.record({ workspaceId, sessionId, trigger, at: now().toISOString(), created: 0, unchanged: 0, error: message })
    return { created: [], unchanged: [], error: message }
  }
}
