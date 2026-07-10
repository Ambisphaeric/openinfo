import { Type, type Static } from '@sinclair/typebox'
import { Id, IsoTime } from '../common.js'
import { AttributionEvidence } from './session.js'

/**
 * The labeled-correction kinds the teach loop consumes (ARCHITECTURE §10 item 2: the confirm/dismiss
 * teaching loop is the quality flywheel for small models). Closed-and-append (like WorkflowStepKind),
 * not open-with-fallback: a signal kind the derivation cannot interpret is a bug to surface, not to
 * silently absorb. Members:
 *  - `reroute` — the session-attribution correction (route/reroute.ts records the moved Session + a
 *    `manual` evidence entry; the `evidence`/`from`/`to` fields below carry it).
 *  - `alias-confirm` / `disambiguate` — the ENTITY-CORRECTION kinds the #75 clarify affordance emits: the
 *    user confirmed the ambiguous mention belongs to the linked candidate (`alias-confirm`) or to the
 *    rival instead (`disambiguate`). Both write a sovereign `EntityOverride` (the `entity` object below
 *    carries the correction); the resolver's override short-circuit then honors the verdict forever.
 *  - `alias-reject` — the mention is NEITHER candidate ("new"); declared here so the correction vocabulary
 *    is complete, wired when a create-a-fresh-entity affordance exists (its durable write needs a
 *    resolution-bypassing create the clarify slice does not add).
 *  - `rename` — a canonical-name correction; declared for a future rename surface (no emitter yet).
 *  - `dismiss` — the long-deferred "not this / not a commitment" signal (#66 dismiss surface); its union
 *    entry lands here so the dismiss surface can emit it without a later contract change.
 * `alias-reject`/`rename`/`dismiss` are DECLARED-not-emitted: no surface produces them yet, matching how
 * `dismiss` was previously named-but-deferred. The derivation (deriveHintCandidates) reads only `reroute`.
 */
export const TeachSignalKind = Type.Union(
  ['reroute', 'alias-confirm', 'alias-reject', 'rename', 'disambiguate', 'dismiss'].map((k) => Type.Literal(k)),
)
export type TeachSignalKind = Static<typeof TeachSignalKind>

/**
 * The ENTITY-CORRECTION payload carried by an entity teach signal (`alias-confirm`/`disambiguate`/
 * `alias-reject`/`rename`) — the "which entity did this heard mention really mean" verdict the #75 clarify
 * affordance records. It is the teach-loop twin of the `EntityOverride` the store writes: `entityId` is the
 * row the ambiguous mention linked to (the clarify affordance rendered on it), `heard` is the surface form
 * being settled, `rivalId`/`rivalName` name the plausible rival the resolver flagged, and `pinnedEntityId`
 * is the entity the form was pinned TO by the verdict (the linked candidate for `alias-confirm`, the rival
 * for `disambiguate`). Human values only — an entity name, never a model/endpoint/template id.
 */
export const EntityCorrectionSignal = Type.Object(
  {
    workspaceId: Id,
    entityId: Id,
    heard: Type.String({ minLength: 1, description: 'the heard surface form the verdict settles' }),
    rivalId: Type.Optional(Id),
    rivalName: Type.Optional(Type.String()),
    pinnedEntityId: Type.Optional(Id),
  },
  { $id: 'EntityCorrectionSignal', additionalProperties: false },
)
export type EntityCorrectionSignal = Static<typeof EntityCorrectionSignal>

/**
 * One labeled teaching signal — a user correction, stored per workspace and fed back as a signal the
 * derivation turns into suggested hint patterns (teach/README: every correction is a labeled signal stored
 * per workspace). `id`, `kind`, `correctedAt` are universal; the rest is variant by `kind`:
 *
 *  - REROUTE (attribution): `fromWorkspaceId`/`toWorkspaceId`/`sessionId`/`evidence` carry it. A `reroute`
 *    records "the router attributed this session to `fromWorkspaceId`, the user corrected it to
 *    `toWorkspaceId`" — the strongest attribution label there is (a human correcting a machine guess).
 *    `evidence` is the router's ORIGINAL attribution trail at correction time (window/repo/calendar +
 *    the appended `manual` marker), preserved verbatim so the derivation can read "router matched these
 *    signals, but they belong to the corrected-to workspace". Stored keyed by `toWorkspaceId`.
 *  - ENTITY CORRECTION (`alias-confirm`/`disambiguate`/`alias-reject`/`rename`): the `entity` object carries
 *    the "which entity did this heard mention mean" verdict (#75). Stored keyed by its `workspaceId`.
 *
 * The reroute fields are OPTIONAL so an entity-correction signal need not fabricate workspace-move
 * semantics it does not have (and vice-versa); a stored reroute signal from before this change still
 * validates unchanged. Which fields are populated is governed by `kind` — the producers set exactly one
 * variant, the store/derivation read the matching one.
 */
export const TeachSignal = Type.Object(
  {
    id: Id,
    kind: TeachSignalKind,
    fromWorkspaceId: Type.Optional(Id),
    toWorkspaceId: Type.Optional(Id),
    sessionId: Type.Optional(Id),
    evidence: Type.Optional(
      Type.Array(AttributionEvidence, {
        description: "reroute only: the router's original attribution trail at correction time (window/repo/calendar + the manual reroute marker)",
      }),
    ),
    entity: Type.Optional(EntityCorrectionSignal),
    correctedAt: IsoTime,
  },
  { $id: 'TeachSignal', additionalProperties: false },
)
export type TeachSignal = Static<typeof TeachSignal>
