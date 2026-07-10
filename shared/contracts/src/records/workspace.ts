import { Type, type Static } from '@sinclair/typebox'
import { Id, IsoTime } from '../common.js'
import { EgressPolicy } from '../config/egress.js'

export const Workspace = Type.Object(
  {
    id: Id,
    name: Type.String({ minLength: 1 }),
    dbFile: Type.String({ description: 'relative path of this workspace\'s OWN sqlite file', pattern: '\\.db$' }),
    color: Type.Optional(Type.String({ pattern: '^#[0-9a-fA-F]{6}$' })),
    retentionDays: Type.Optional(Type.Integer({ minimum: 1, description: 'distillate retention; raw always deletes post-distill' })),
    // Layer 3 of the egress-consent policy (#64): a workspace may deny egress wholesale (the broadest
    // content-side layer). Append-only/optional — absent ⇒ the workspace does not deny.
    egress: Type.Optional(EgressPolicy),
    createdAt: IsoTime,
  },
  { $id: 'Workspace', additionalProperties: false },
)
export type Workspace = Static<typeof Workspace>
