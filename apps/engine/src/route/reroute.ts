import type { Session } from '@openinfo/contracts'
import type { WorkspaceRegistry } from '../store/index.js'

/**
 * The outcome of a reroute attempt — an HTTP status plus either the moved Session or an error
 * message. Kept transport-shaped-but-framework-free so the http handler stays a thin mapper and the
 * policy is unit-testable without a server (mirroring the engine's pure-logic / imperative-shell split).
 */
export type RerouteResult =
  | { status: 200; session: Session }
  | { status: 400 | 404 | 409; error: string }

/**
 * The one-click retroactive reroute policy (Phase 3, the correction loop; IMPLEMENTATION §3 risk
 * register). route/ decides, store/ moves — the DB-handle rule. Guards, in order:
 *  - unknown session → 404.
 *  - same workspace → 400 (a no-op the caller should not have asked for; the store also refuses).
 *  - unknown destination workspace → 400 (reroute corrects attribution TO an existing workspace; we
 *    do not conjure a workspace from a correction click — creation is a separate flow).
 *  - LIVE (unended) session → 409. v0 reroutes only ENDED sessions: a live session has in-flight
 *    capture/drain state (raw chunks still spooling, distillates still being written into the source
 *    DB), and moving it would race the drain writing into a workspace the session just left. End it,
 *    then reroute — the correction loop corrects a completed span.
 *
 * On success the store moves the records + stamps reroutedFrom; here we APPEND a `manual`
 * attribution-evidence entry ("rerouted by user") rather than replacing history — the original
 * (router) evidence is preserved so the teaching loop can later read "router said X, user corrected
 * to Y". Confidence becomes 1.0: a manual correction is the authoritative attribution.
 */
export function rerouteSession(store: WorkspaceRegistry, sessionId: string, toWorkspaceId: string): RerouteResult {
  const session = store.findSession(sessionId)
  if (!session) return { status: 404, error: `no such session: ${sessionId}` }
  const fromWorkspaceId = session.workspaceId
  if (fromWorkspaceId === toWorkspaceId) return { status: 400, error: `session ${sessionId} is already in workspace ${toWorkspaceId}` }
  if (!store.all().some((ws) => ws.id === toWorkspaceId)) return { status: 400, error: `no such workspace: ${toWorkspaceId}` }
  if (session.endedAt === undefined) return { status: 409, error: `end session ${sessionId} before rerouting (v0 reroutes ended sessions only)` }

  const moved = store.moveSession(sessionId, fromWorkspaceId, toWorkspaceId)
  const attributed: Session = {
    ...moved,
    attribution: {
      evidence: [...moved.attribution.evidence, { kind: 'manual', detail: `rerouted from workspace ${fromWorkspaceId} by user`, weight: 1 }],
      confidence: 1,
    },
  }
  return { status: 200, session: store.saveSession(attributed) }
}
