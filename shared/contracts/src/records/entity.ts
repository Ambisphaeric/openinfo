import { Type, type Static } from '@sinclair/typebox'
import { Id, IsoTime, SlotName } from '../common.js'

export const EntityKind = Type.Union(['person', 'artifact', 'topic'].map((k) => Type.Literal(k)))

/**
 * Where an entity mention came from — the distillate/window it was resolved over and the
 * endpoint/model that produced it. One entry per window that mentioned the entity, so a surfaced
 * entity carries an inspectable trail back to every window and model that named it (product
 * principle 1). Additive, backward-compatible; Phase-0 entities without provenance still validate.
 */
export const EntityProvenance = Type.Object(
  {
    distillateId: Type.Optional(Id),
    windowStart: Type.Optional(IsoTime),
    windowEnd: Type.Optional(IsoTime),
    slot: SlotName,
    endpoint: Type.String({ minLength: 1, description: 'fabric endpoint name that produced this mention' }),
    model: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
)
export type EntityProvenance = Static<typeof EntityProvenance>

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
    mentions: Type.Optional(
      Type.Integer({
        minimum: 0,
        default: 0,
        description: 'windows/distillates that mentioned this entity — the frequency signal for recency×frequency ranking',
      }),
    ),
    provenance: Type.Optional(
      Type.Array(EntityProvenance, {
        description: 'per-window trail: which distillate/window/model mentioned this entity (noise is inspectable)',
      }),
    ),
    firstSeen: IsoTime,
    lastSeen: IsoTime,
  },
  { $id: 'Entity', additionalProperties: false },
)
export type Entity = Static<typeof Entity>
