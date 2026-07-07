import { Type, type Static } from '@sinclair/typebox'
import { Id, IsoTime } from '../common.js'

export const Pin = Type.Object(
  {
    id: Id,
    workspaceId: Id,
    uri: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1 }),
    kind: Type.Union(['pdf', 'gdoc', 'url', 'file'].map((k) => Type.Literal(k))),
    ingest: Type.Object(
      {
        status: Type.Union(['pending', 'ingested', 'failed'].map((s) => Type.Literal(s))),
        pages: Type.Optional(Type.Integer({ minimum: 1 })),
        chunks: Type.Optional(Type.Integer({ minimum: 0 })),
        lastFetchedAt: Type.Optional(IsoTime),
        error: Type.Optional(Type.String()),
      },
      { additionalProperties: false, description: 'pins are ingested (fetched, page-anchored, embedded), not bookmarked' },
    ),
    createdAt: IsoTime,
  },
  { $id: 'Pin', additionalProperties: false },
)
export type Pin = Static<typeof Pin>
