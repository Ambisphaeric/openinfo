import { Type, type Static } from '@sinclair/typebox'

export const Flag = Type.Object(
  {
    key: Type.String({ pattern: '^[a-z][a-z0-9]*(\\.[a-z][a-z0-9-]*)+$', description: 'e.g. surface.block.pinned-doc' }),
    default: Type.Boolean(),
    scope: Type.Union(['engine', 'surface', 'mode'].map((s) => Type.Literal(s))),
    description: Type.String({ minLength: 1 }),
    minTier: Type.Optional(Type.Union(['T0', 'T1', 'T2', 'T3'].map((t) => Type.Literal(t)))),
  },
  { $id: 'Flag', additionalProperties: false, description: 'every feature ships OFF behind one of these' },
)
export type Flag = Static<typeof Flag>
