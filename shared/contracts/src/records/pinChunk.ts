import { Type, type Static } from '@sinclair/typebox'
import { Id, IsoTime } from '../common.js'

/**
 * One page-anchored chunk of an ingested pin (index/README: "chunk with page anchors" — how an answer
 * cites "p. 42" with a copy-ready excerpt, ARCHITECTURE §5 earned-vs-pinned canon). A pin is FETCHED,
 * split into ordered chunks, and each chunk keeps the `page` it came from so a retrieved excerpt can be
 * cited back to its source location. `ordinal` is the chunk's global sequence within the pin (stable
 * ordering for retrieval + re-assembly); `page` is the 1-based source page anchor — OPTIONAL because
 * pageless sources (a web URL, a single plaintext blob) have no page to cite, and a fabricated page
 * number would lie about where the text came from. Chunks are store-owned records (ids/createdAt
 * store-stamped), the pinned-canon analogue of an entity — workspace-level, not session-keyed.
 */
export const PinChunk = Type.Object(
  {
    id: Id,
    pinId: Id,
    workspaceId: Id,
    ordinal: Type.Integer({ minimum: 0, description: 'chunk sequence within the pin (0-based, stable)' }),
    page: Type.Optional(Type.Integer({ minimum: 1, description: '1-based source page anchor; absent for pageless sources (url/plaintext)' })),
    text: Type.String({ minLength: 1 }),
    createdAt: IsoTime,
  },
  { $id: 'PinChunk', additionalProperties: false },
)
export type PinChunk = Static<typeof PinChunk>
