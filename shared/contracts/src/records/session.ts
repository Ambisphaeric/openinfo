import { Type, type Static } from '@sinclair/typebox'
import { Id, IsoTime, Confidence } from '../common.js'

export const AttributionEvidence = Type.Object(
  {
    kind: Type.Union(['calendar', 'window', 'repo', 'voice', 'manual'].map((k) => Type.Literal(k))),
    detail: Type.String(),
    weight: Confidence,
  },
  { additionalProperties: false },
)

export const Session = Type.Object(
  {
    id: Id,
    workspaceId: Id,
    modeId: Id,
    startedAt: IsoTime,
    endedAt: Type.Optional(IsoTime),
    title: Type.Optional(Type.String()),
    attribution: Type.Object(
      { evidence: Type.Array(AttributionEvidence), confidence: Confidence },
      { additionalProperties: false },
    ),
    registerId: Type.Optional(Id),
    reroutedFrom: Type.Optional(Type.String({ minLength: 1, description: 'workspace id, if retroactively moved' })),
  },
  { $id: 'Session', additionalProperties: false },
)
export type Session = Static<typeof Session>
