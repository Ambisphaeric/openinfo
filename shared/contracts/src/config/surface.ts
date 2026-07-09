import { Type, type Static } from '@sinclair/typebox'
import { Id } from '../common.js'

/** Append-only. Adding a name here is step 1 of the CONTRIBUTING "add a block type" recipe. */
export const BlockTypeName = Type.Union(
  ['now', 'moments', 'relevant-now', 'ledger', 'pinned-doc', 'hint', 'ask', 'todos', 'drafts', 'teach', 'distillates', 'queue', 'custom'].map((b) => Type.Literal(b)),
  { $id: 'BlockTypeName' },
)
export type BlockTypeName = Static<typeof BlockTypeName>

/**
 * The block query DSL — DECISION (Phase 0): a declarative JSON pipeline, not a string language.
 * Compiled server-side to store calls; custom blocks get the same shape, so they can never
 * express something the engine wouldn't allow.
 */
export const BlockQuery = Type.Object(
  {
    source: Type.Union(
      ['relevant-now', 'moments', 'ledger', 'sessions', 'pins', 'entities', 'todos', 'drafts', 'teach', 'distillates', 'queue'].map((s) => Type.Literal(s)),
    ),
    params: Type.Record(Type.String(), Type.Unknown(), { default: {} }),
    top: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  },
  { $id: 'BlockQuery', additionalProperties: false },
)
export type BlockQuery = Static<typeof BlockQuery>

export const Action = Type.Object(
  {
    id: Id,
    label: Type.String({ minLength: 1, maxLength: 24 }),
    verb: Type.Union(
      ['copy', 'open', 'mark-done', 'dismiss', 'run-mode', 'draft-with', 'navigate'].map((v) => Type.Literal(v)),
    ),
    params: Type.Record(Type.String(), Type.Unknown(), { default: {} }),
  },
  { $id: 'Action', additionalProperties: false, description: 'the app prepares; verbs never send/commit/reply outward' },
)
export type Action = Static<typeof Action>

export const Block = Type.Object(
  {
    block: BlockTypeName,
    id: Type.Optional(Id),
    query: Type.Optional(BlockQuery),
    show: Type.Optional(Type.Union(['always', 'on-match', 'manual'].map((s) => Type.Literal(s)))),
    collapsed: Type.Optional(Type.Boolean()),
    top: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: 'HUD shows top-K; workbench holds the rest' })),
    use: Type.Optional(
      Type.Object(
        { llm: Type.Optional(Type.String()), register: Type.Optional(Id) },
        { additionalProperties: false },
      ),
    ),
    actions: Type.Optional(Type.Array(Action)),
    custom: Type.Optional(
      Type.Object(
        { htmlEndpoint: Type.String({ description: 'engine-served, sandboxed; API-only reach' }) },
        { additionalProperties: false },
      ),
    ),
  },
  { $id: 'Block', additionalProperties: false },
)
export type Block = Static<typeof Block>

export const Surface = Type.Object(
  {
    id: Id,
    name: Type.String({ minLength: 1 }),
    context: Type.String({ minLength: 1, description: 'meeting | deep-work | idle | any | user-defined' }),
    stack: Type.Array(Block, { minItems: 1 }),
    version: Type.Integer({ minimum: 1 }),
  },
  { $id: 'Surface', additionalProperties: false },
)
export type Surface = Static<typeof Surface>
