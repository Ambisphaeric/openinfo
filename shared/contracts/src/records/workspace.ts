import { Type, type Static } from '@sinclair/typebox'
import { Id, IsoTime } from '../common.js'

export const Workspace = Type.Object(
  {
    id: Id,
    name: Type.String({ minLength: 1 }),
    dbFile: Type.String({ description: 'relative path of this workspace\'s OWN sqlite file', pattern: '\\.db$' }),
    color: Type.Optional(Type.String({ pattern: '^#[0-9a-fA-F]{6}$' })),
    retentionDays: Type.Optional(Type.Integer({ minimum: 1, description: 'distillate retention; raw always deletes post-distill' })),
    createdAt: IsoTime,
  },
  { $id: 'Workspace', additionalProperties: false },
)
export type Workspace = Static<typeof Workspace>
