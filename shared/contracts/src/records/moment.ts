import { Type, type Static } from '@sinclair/typebox'
import { Id, IsoTime, Confidence, InvokeUsage, SlotName } from '../common.js'
import { EgressDecision } from '../config/egress.js'
import { GuardVerdict } from '../config/guard.js'

export const MomentKind = Type.Union(
  ['commitment', 'question', 'decision', 'artifact', 'mention', 'note'].map((k) => Type.Literal(k)),
  { description: '● commitment · ◆ question-at-you · ▲ decision · ✱ artifact · mention-of-user · note' },
)

/**
 * Where a moment came from — the distillate/window it was extracted over and the endpoint/model
 * that produced it. Optional (Phase-0 moments predate extraction); the distill-pass extractor
 * stamps it so every surfaced moment carries a one-line why (product principle 1). Additive,
 * backward-compatible: existing moments without provenance still validate.
 */
export const MomentProvenance = Type.Object(
  {
    distillateId: Type.Optional(Id),
    windowStart: Type.Optional(IsoTime),
    windowEnd: Type.Optional(IsoTime),
    slot: SlotName,
    endpoint: Type.String({ minLength: 1, description: 'fabric endpoint name that produced this' }),
    model: Type.Optional(Type.String()),
    // #65/#116: provenance from the ACTUAL typed-moment extraction invoke (the second model call), not
    // copied from the preceding summary call. Optional/additive for moments created before this repair.
    usage: Type.Optional(InvokeUsage),
    // #64/#63: the extraction call's own destination + guard truth. Summary and moment extraction may
    // fall through to different endpoints, so these must never be inherited from the summary record.
    egress: Type.Optional(EgressDecision),
    guard: Type.Optional(GuardVerdict),
  },
  { additionalProperties: false },
)
export type MomentProvenance = Static<typeof MomentProvenance>

export const Moment = Type.Object(
  {
    id: Id,
    sessionId: Id,
    workspaceId: Id,
    at: IsoTime,
    kind: MomentKind,
    text: Type.String({ minLength: 1 }),
    speaker: Type.Optional(Type.String({ description: 'person entity id or raw label' })),
    refs: Type.Array(Id, { description: 'entity ids referenced by this moment', default: [] }),
    source: Type.Union(['mic', 'screen', 'calendar', 'repo', 'camera', 'system-audio'].map((s) => Type.Literal(s))),
    confidence: Confidence,
    answered: Type.Optional(Type.Boolean({ description: 'questions only: heard an answer yet?' })),
    provenance: Type.Optional(MomentProvenance),
    // #116: the correlation id of the pipeline pass that extracted this moment — shared with the window's
    // distillate (whose id `provenance.distillateId` already names as the parent link). Append-only/optional.
    spanId: Type.Optional(Id),
  },
  { $id: 'Moment', additionalProperties: false },
)
export type Moment = Static<typeof Moment>
