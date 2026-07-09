import { Type, type Static } from '@sinclair/typebox'
import { Id, IsoTime, Confidence, SlotName } from '../common.js'

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
  },
  { $id: 'Moment', additionalProperties: false },
)
export type Moment = Static<typeof Moment>
