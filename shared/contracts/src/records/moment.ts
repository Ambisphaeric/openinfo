import { Type, type Static } from '@sinclair/typebox'
import { Id, IsoTime, Confidence } from '../common.js'

export const MomentKind = Type.Union(
  ['commitment', 'question', 'decision', 'artifact', 'mention', 'note'].map((k) => Type.Literal(k)),
  { description: '● commitment · ◆ question-at-you · ▲ decision · ✱ artifact · mention-of-user · note' },
)

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
    source: Type.Union(['mic', 'screen', 'calendar', 'repo', 'camera'].map((s) => Type.Literal(s))),
    confidence: Confidence,
    answered: Type.Optional(Type.Boolean({ description: 'questions only: heard an answer yet?' })),
  },
  { $id: 'Moment', additionalProperties: false },
)
export type Moment = Static<typeof Moment>
