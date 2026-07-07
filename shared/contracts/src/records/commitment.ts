import { Type, type Static } from '@sinclair/typebox'
import { Id, IsoTime, Confidence } from '../common.js'

export const CommitmentStatus = Type.Union(
  ['open', 'prepared', 'done', 'dismissed'].map((s) => Type.Literal(s)),
)

export const Watcher = Type.Object(
  {
    kind: Type.Union(['repo', 'doc', 'mail', 'manual'].map((k) => Type.Literal(k))),
    config: Type.Record(Type.String(), Type.Unknown(), { description: 'watcher-kind-specific, e.g. { repo, pathGlob }' }),
    lastChecked: Type.Optional(IsoTime),
    evidence: Type.Optional(
      Type.Object(
        { found: Type.Boolean(), detail: Type.String(), at: IsoTime },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
)
export type Watcher = Static<typeof Watcher>

export const Commitment = Type.Object(
  {
    id: Id,
    workspaceId: Id,
    text: Type.String({ minLength: 1 }),
    provenance: Type.Object(
      { momentId: Id, sessionId: Id, heardAt: IsoTime },
      { additionalProperties: false, description: 'nothing without a why' },
    ),
    owedTo: Type.Array(Id, { description: 'person entity ids', default: [] }),
    due: Type.Optional(IsoTime),
    confidence: Confidence,
    status: CommitmentStatus,
    statusHistory: Type.Array(
      Type.Object(
        {
          status: CommitmentStatus,
          at: IsoTime,
          by: Type.Union(['user', 'watcher', 'system'].map((b) => Type.Literal(b))),
        },
        { additionalProperties: false },
      ),
    ),
    watchers: Type.Array(Watcher, { default: [] }),
    prepared: Type.Optional(
      Type.Object(
        {
          artifactKind: Type.Union(['email-draft', 'excerpt', 'text'].map((k) => Type.Literal(k))),
          content: Type.String(),
          preparedAt: IsoTime,
        },
        { additionalProperties: false, description: 'the app prepares; the human executes' },
      ),
    ),
    context: Type.Object(
      {
        fileRefs: Type.Optional(Type.Array(Type.String())),
        screenshotRefs: Type.Optional(Type.Array(Type.String())),
        prRefs: Type.Optional(Type.Array(Type.String())),
      },
      { additionalProperties: false, default: {}, description: 'born-with-context: what was on screen when it was heard' },
    ),
  },
  { $id: 'Commitment', additionalProperties: false },
)
export type Commitment = Static<typeof Commitment>
