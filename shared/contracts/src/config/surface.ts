import { Type, type Static } from '@sinclair/typebox'
import { Id } from '../common.js'

/** Append-only. Adding a name here is step 1 of the CONTRIBUTING "add a block type" recipe. */
export const BlockTypeName = Type.Union(
  (['now', 'moments', 'relevant-now', 'ledger', 'pinned-doc', 'hint', 'ask', 'todos', 'drafts', 'teach', 'distillates', 'summaries', 'fields', 'queue', 'transcript-inspector', 'sense-gates', 'input', 'custom', 'sense-lanes', 'session-control', 'sessions'] as const).map((b) => Type.Literal(b)),
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
      (['relevant-now', 'moments', 'ledger', 'sessions', 'pins', 'entities', 'todos', 'drafts', 'teach', 'distillates', 'summaries', 'fields', 'queue', 'transcript', 'senses', 'live-senses'] as const).map((s) => Type.Literal(s)),
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
      (['copy', 'open', 'mark-done', 'dismiss', 'run-mode', 'draft-with', 'navigate', 'accept', 'pin', 'mark-for-follow-up', 'session-start', 'session-stop'] as const).map((v) => Type.Literal(v)),
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
    show: Type.Optional(Type.Union((['always', 'on-match', 'manual'] as const).map((s) => Type.Literal(s)))),
    collapsed: Type.Optional(Type.Boolean()),
    top: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: 'HUD shows top-K; workbench holds the rest' })),
    use: Type.Optional(
      Type.Object(
        { llm: Type.Optional(Type.String()), register: Type.Optional(Id) },
        { additionalProperties: false },
      ),
    ),
    actions: Type.Optional(Type.Array(Action)),
    states: Type.Optional(
      Type.Array(
        Type.Object(
          {
            key: Type.String({ minLength: 1, description: 'the value a hydrated item carries in its `state` field' }),
            tone: Type.String({ minLength: 1, description: 'the dot colour tone class (provisional | confirmed | corrected shipped; a custom key maps to any tone)' }),
          },
          { additionalProperties: false },
        ),
        {
          description:
            'micro-state dot vocabulary override: field-state key → dot tone. Absent ⇒ the shipped default vocab (provisional/confirmed/corrected). Lets a document re-vocabularize the dot per surface (e.g. approved/denied/tabled) without a code change.',
        },
      ),
    ),
    custom: Type.Optional(
      Type.Object(
        { htmlEndpoint: Type.String({ description: 'engine-served, sandboxed; API-only reach' }) },
        { additionalProperties: false },
      ),
    ),
    /**
     * The `input` block's config (#134) — the text-entry / file-drop PRIMITIVE. `target` names WHAT the
     * entry feeds (a free identifier the surface author chooses: `chat`, `entity-map`, `pins`…) and
     * `submit` is the engine route the entry POSTs to; both are DOCUMENT fields, so a different document
     * wires the same primitive to a different destination with no code change. `mode` picks text / file /
     * both (default `text`); `accept` is the file-drop filter (mode file/both). A FAILED submit paints
     * visible text on the button (the QA doctrine — never a silent no-op). Present only on `input` blocks.
     */
    input: Type.Optional(
      Type.Object(
        {
          target: Type.String({ minLength: 1, description: 'what the entry feeds — a free identifier (chat | entity-map | pins | …)' }),
          submit: Type.String({ minLength: 1, description: 'engine route the entry POSTs to, e.g. "/chat"; a failed submit surfaces as visible text' }),
          mode: Type.Optional(Type.Union((['text', 'file', 'both'] as const).map((m) => Type.Literal(m)), { description: 'text-entry, file-drop, or both; absent ⇒ text' })),
          placeholder: Type.Optional(Type.String()),
          submitLabel: Type.Optional(Type.String({ description: 'submit affordance label; absent ⇒ "Send"' })),
          accept: Type.Optional(Type.String({ description: 'file-drop accept filter (MIME/extension), e.g. ".pdf,.txt,.md"; mode file/both only' })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { $id: 'Block', additionalProperties: false },
)
export type Block = Static<typeof Block>

/**
 * The attached-expansion-panel geometry PRIMITIVE (#134) — a surface document declares that its window is
 * an attached panel with a collapsed and an expanded size along one edge, and the shell honors it with real
 * window bounds (rides the content-sizing + WindowRegistry machinery). `edge` picks the axis: `below` sizes
 * HEIGHT (the below-HUD chat panel, expanded ~3× its collapsed bar), `right` sizes WIDTH (the collapsible
 * sidebar). `collapsed`/`expanded` are the window CONTENT size (px) along that axis; the orthogonal axis
 * keeps the surface's configured width. `reveal` is the trigger contract: `user` = manual expand/collapse
 * only; `event` = ALSO opens as a DISMISSIBLE SUGGESTION when a matching bus event arrives (never modal,
 * never auto-capture — the suggestion pattern). `openOn` is the event name (or `prefix.` prefix) that
 * suggests opening; it is matched tolerantly, so a trigger event still being built in parallel is a
 * no-op-until-present rather than an error. `startExpanded` sets the initial state (absent ⇒ collapsed).
 */
export const AttachedPanel = Type.Object(
  {
    edge: Type.Union([Type.Literal('below'), Type.Literal('right')], { description: 'below ⇒ expand height; right ⇒ expand width' }),
    collapsed: Type.Integer({ minimum: 0, description: 'window content size (px) along the edge axis when collapsed' }),
    expanded: Type.Integer({ minimum: 1, description: 'window content size (px) along the edge axis when expanded' }),
    reveal: Type.Union([Type.Literal('user'), Type.Literal('event')], { description: 'user = manual toggle only; event = also opens as a dismissible suggestion on a matching bus event' }),
    openOn: Type.Optional(Type.String({ minLength: 1, description: 'event name (or "prefix." prefix) that SUGGESTS opening when reveal:"event"; matched tolerantly — an absent event is a no-op' })),
    startExpanded: Type.Optional(Type.Boolean({ description: 'initial state; absent ⇒ collapsed' })),
  },
  { $id: 'AttachedPanel', additionalProperties: false },
)
export type AttachedPanel = Static<typeof AttachedPanel>

export const Surface = Type.Object(
  {
    id: Id,
    name: Type.String({ minLength: 1 }),
    context: Type.String({ minLength: 1, description: 'meeting | deep-work | idle | any | user-defined' }),
    stack: Type.Array(Block, { minItems: 1 }),
    version: Type.Integer({ minimum: 1 }),
    workspaceId: Type.Optional(Id),
    /** #134: when present, this surface's window is an attached expansion panel — see AttachedPanel. Absent ⇒ an ordinary window. */
    panel: Type.Optional(AttachedPanel),
  },
  {
    $id: 'Surface',
    additionalProperties: false,
    description:
      'workspaceId (#99, append-only, optional): an APP INSTANCE is this surface bound to a workspace silo. When present it becomes the DEFAULT workspace for this surface’s block queries (POST /query?surface=<id>) — an explicit per-block params.workspace still wins. Absent ⇒ unchanged behavior (queries default to ‘default’). Same template instantiated for N repos = N surfaces, each naming its own workspace.',
  },
)
export type Surface = Static<typeof Surface>
