import { Type, type Static } from '@sinclair/typebox'
import { Id, IsoTime } from '../common.js'

export const EntityKind = Type.Union(['person', 'artifact', 'topic'].map((k) => Type.Literal(k)))

export const Entity = Type.Object(
  {
    id: Id,
    workspaceId: Id,
    kind: EntityKind,
    name: Type.String({ minLength: 1 }),
    aliases: Type.Array(Type.String(), { default: [] }),
    canonicalOf: Type.Optional(Type.Array(Id, { description: 'entity ids merged into this one' })),
    pinId: Type.Optional(Id),
    momentRefs: Type.Array(Id, { default: [] }),
    outboundCount: Type.Integer({ minimum: 0, default: 0, description: 'times SENT to someone — strongest canon signal' }),
    firstSeen: IsoTime,
    lastSeen: IsoTime,
  },
  { $id: 'Entity', additionalProperties: false },
)
export type Entity = Static<typeof Entity>
