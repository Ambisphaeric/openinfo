import { Type, type Static } from '@sinclair/typebox'
import { Id, IsoTime } from '../common.js'
import { AttributionEvidence } from './session.js'

/**
 * The labeled-correction kinds the teach loop consumes (ARCHITECTURE §10 item 2: the confirm/dismiss
 * teaching loop is the quality flywheel for small models). Open, append-only union — `reroute` is the
 * only wired kind in v0 (route/reroute.ts already records the correction as a moved Session + a `manual`
 * evidence entry); `dismiss` ("not a commitment" / "not this entity") is the next member, deferred until
 * a dismiss surface exists to emit it. Closed-and-append (like WorkflowStepKind), not open-with-fallback:
 * a signal kind the derivation cannot interpret is a bug to surface, not to silently absorb.
 */
export const TeachSignalKind = Type.Union(['reroute'].map((k) => Type.Literal(k)))
export type TeachSignalKind = Static<typeof TeachSignalKind>

/**
 * One labeled teaching signal — a user correction, stored per workspace and fed back as a signal the
 * derivation turns into suggested hint patterns (teach/README: every reroute/dismiss is a labeled signal
 * stored per workspace). A `reroute` records "the router attributed this session to `fromWorkspaceId`, the
 * user corrected it to `toWorkspaceId`" — the strongest attribution label there is (a human correcting a
 * machine guess). `evidence` is the router's ORIGINAL attribution trail at correction time (the window/
 * repo/calendar signals it matched, PLUS the appended `manual` reroute marker), preserved verbatim so the
 * derivation can read "router matched these signals, but they belong to the corrected-to workspace".
 *
 * Stored keyed by `toWorkspaceId` (the workspace that should LEARN to claim these signals); `fromWorkspaceId`
 * is retained so a future derivation can also learn the negative ("these signals do NOT mean the source").
 */
export const TeachSignal = Type.Object(
  {
    id: Id,
    kind: TeachSignalKind,
    fromWorkspaceId: Id,
    toWorkspaceId: Id,
    sessionId: Id,
    evidence: Type.Array(AttributionEvidence, {
      description: "the router's original attribution trail at correction time (window/repo/calendar + the manual reroute marker)",
    }),
    correctedAt: IsoTime,
  },
  { $id: 'TeachSignal', additionalProperties: false },
)
export type TeachSignal = Static<typeof TeachSignal>
