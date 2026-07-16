import { Type, type Static } from '@sinclair/typebox'
import { Id, IsoTime, Confidence } from '../common.js'
import { AttributionEvidence } from './session.js'

/** Schema version of the ContextPacket record shape — bumped when the persisted shape changes. */
export const CONTEXT_PACKET_SCHEMA_VERSION = 1

/**
 * One reference to a stored source observation (#176). A packet NEVER copies observation content — it
 * points at the immutable record (SttSegment / OcrResult / Distillate / Moment) by id, so every
 * assertion a packet makes stays traceable to its source and no ambient content is duplicated into a
 * second table. `at` is the observation instant the correlation used (the capture time where the source
 * record carries one), carried so a consumer can see WHY the ref landed in this window without loading it.
 */
export const ContextPacketRef = Type.Object(
  {
    record: Type.Union(['stt-segment', 'ocr-result', 'distillate', 'moment'].map((r) => Type.Literal(r)), {
      description: 'which record table the id names — the closed set of packet-referencable observations',
    }),
    id: Id,
    at: IsoTime,
  },
  { $id: 'ContextPacketRef', additionalProperties: false },
)
export type ContextPacketRef = Static<typeof ContextPacketRef>

/**
 * An honestly-missing sense (#176). When a window has no stored observations for a lane the packet does
 * NOT guess or fill — it degrades to a partial packet and names the machine-readable reason:
 * `no-observations-this-session` (the lane produced nothing anywhere in the session — likely never
 * captured) vs `no-observations-in-window` (the lane exists in this session but was silent this window).
 */
export const ContextPacketGap = Type.Object(
  {
    lane: Type.Union(['mic', 'system-audio', 'screen'].map((l) => Type.Literal(l)), {
      description: 'the physical sense lane that is missing from this window',
    }),
    reason: Type.Union(['no-observations-this-session', 'no-observations-in-window'].map((r) => Type.Literal(r))),
  },
  { $id: 'ContextPacketGap', additionalProperties: false },
)
export type ContextPacketGap = Static<typeof ContextPacketGap>

/**
 * A candidate entity this window's evidence names (#176). `momentRefs` are the in-window moments whose
 * `refs` name the entity (each moment record carries its own source lane — attribution stays on the
 * source, never merged into the candidate). `seenOnScreen` is present ONLY when an in-window screen
 * observation independently corroborated the entity (the #74 correlator over the OCR surface forms):
 * it names the exact OcrResult, the on-screen form that matched, and the measured similarity — evidence
 * with provenance, never a bare boolean the user has to trust.
 */
export const ContextPacketCandidate = Type.Object(
  {
    entityId: Id,
    name: Type.String({ minLength: 1, description: 'the entity record name at build time — the lookup key stays entityId' }),
    momentRefs: Type.Array(Id, { minItems: 1, description: 'in-window moment ids whose refs name this entity' }),
    seenOnScreen: Type.Optional(
      Type.Object(
        {
          ocrId: Id,
          form: Type.String({ minLength: 1, description: 'the on-screen surface form that corroborated (evidence, not a secret value)' }),
          similarity: Confidence,
        },
        { additionalProperties: false, description: 'cross-source corroboration by an in-window screen observation (#74 correlator)' },
      ),
    ),
  },
  { $id: 'ContextPacketCandidate', additionalProperties: false },
)
export type ContextPacketCandidate = Static<typeof ContextPacketCandidate>

/**
 * How this packet was built (#176). Slice 1 has exactly one builder — the deterministic engine-side
 * correlator (`index/packets.ts`): pure time/session/entity-evidence correlation over stored records,
 * no model in the loop. The literal keeps that inspectable: a future model-assisted builder must
 * declare itself as a NEW literal (fast-model output is proposal, not truth — roadmap #189), it can
 * never impersonate the deterministic one. `windowMs` is the correlation window the packet was built
 * with, so a packet's membership is reproducible from its own record.
 */
export const ContextPacketProvenance = Type.Object(
  {
    builder: Type.Literal('deterministic-correlation'),
    windowMs: Type.Integer({ minimum: 1, description: 'the correlation window length this packet was bucketed with' }),
  },
  { $id: 'ContextPacketProvenance', additionalProperties: false },
)
export type ContextPacketProvenance = Static<typeof ContextPacketProvenance>

/**
 * A converged slice of activity (#176) — one correlation window's view over what was heard and seen,
 * built ONLY from references to immutable source observations. The packet is a DERIVED runtime unit:
 * it never replaces, copies, or rewrites the observations it points at, and the three sense lanes stay
 * separate fields — a packet may correlate a screen observation with BOTH audio lanes without ever
 * merging their attribution (the non-negotiable source-identity invariant).
 *
 * SUPERSESSION is append-only: a late or out-of-order observation produces a NEW packet whose
 * `supersedes` names the prior revision and whose `revision` increments — the prior packet is never
 * mutated or deleted, so the chain stays walkable. Readers default to the latest revision (the store's
 * list excludes superseded packets unless asked). `id` is content-derived (a hash over the packet's
 * correlated content + chain position), so rebuilding the same window from the same observations is
 * idempotent: byte-identical packet, same id, no new revision.
 *
 * There is deliberately NO prose field: packet prose is a derived view assembled from the referenced
 * records at read time — persisting it would duplicate ambient content into a second table and detach
 * assertions from their sources.
 */
export const ContextPacket = Type.Object(
  {
    id: Id,
    workspaceId: Id,
    sessionId: Id,
    windowStart: IsoTime,
    windowEnd: IsoTime,
    microphone: Type.Array(ContextPacketRef, { description: 'mic-lane observation refs — attribution never merges with the other lanes' }),
    systemAudio: Type.Array(ContextPacketRef, { description: 'system-audio-lane observation refs — the OTHER audio attribution, kept separate' }),
    screen: Type.Array(ContextPacketRef, { description: 'screen-understanding observation refs (OcrResults)' }),
    focus: Type.Optional(
      Type.Array(AttributionEvidence, {
        description: "foreground/app evidence from the session record's attribution (kinds window/repo) — sourced via sessionId, never model-derived",
      }),
    ),
    candidates: Type.Array(ContextPacketCandidate, { description: 'entities the in-window evidence names, each traceable to its moments' }),
    gaps: Type.Array(ContextPacketGap, { description: 'senses honestly missing from this window, with machine-readable reasons' }),
    confidence: Confidence,
    provenance: ContextPacketProvenance,
    revision: Type.Integer({ minimum: 1, description: 'position in this window’s append-only supersession chain' }),
    supersedes: Type.Optional(Id),
    schemaVersion: Type.Integer({ minimum: 1 }),
    createdAt: IsoTime,
  },
  { $id: 'ContextPacket', additionalProperties: false },
)
export type ContextPacket = Static<typeof ContextPacket>
