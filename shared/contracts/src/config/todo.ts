import { Type, type Static } from '@sinclair/typebox'
import { Id, IsoTime } from '../common.js'

/**
 * Where one to-do item came from — the extraction pass's provenance trail so every surfaced item
 * carries a one-line why (product principle 1), and a user editing the list can see which came from
 * the model vs their own hand. All optional: a user-added item has no distillate/moment behind it,
 * only the session it belongs to. Additive, backward-compatible.
 */
export const TodoProvenance = Type.Object(
  {
    sessionId: Type.Optional(Id),
    distillateId: Type.Optional(Id),
    momentId: Type.Optional(Id),
  },
  { $id: 'TodoProvenance', additionalProperties: false },
)
export type TodoProvenance = Static<typeof TodoProvenance>

/**
 * One accumulated follow-up item — the STRUCTURED (constrained) form the `task-extract` act distills
 * a meeting's distillates/moments into, and the un-constrained draft interpolates back into prose via
 * `{{todo}}`. `done` lets a user check items off; `provenance` records the extraction trail. Ids and
 * timestamps are server-stamped (the model never controls them), exactly like Moment/Distillate.
 */
export const TodoItem = Type.Object(
  {
    id: Id,
    text: Type.String({ minLength: 1, description: 'the follow-up, as a short imperative line' }),
    done: Type.Optional(Type.Boolean({ description: 'user checked it off; extraction never sets this' })),
    provenance: Type.Optional(TodoProvenance),
    createdAt: IsoTime,
  },
  { $id: 'TodoItem', additionalProperties: false },
)
export type TodoItem = Static<typeof TodoItem>

/**
 * A session's accumulated to-do list — an EDITABLE, versioned document (the everything-is-a-document
 * rule, ARCHITECTURE §2), homed in the house documents store keyed by its session id so it gets the
 * read/write route + version history for free, like Surface/WorkflowSpec. This is the user's
 * constrain/unconstrain loop's state: the `task-extract` act CONSTRAINS the meeting into `items`
 * (deduped, provenance-stamped) across drains; a draft UN-CONSTRAINS them back into prose via the
 * `{{todo}}` template variable. A user can PUT an edited `items` array and the next draft reflects it.
 *
 * Envelope follows the house convention (id · name · version · description?) with the session/workspace
 * it belongs to. `version` is store-stamped monotonic (LayoutStore keeps every prior version). `id`
 * equals the owning session id (globally unique), so the document is addressable as `/todos/:sessionId`.
 */
export const TodoList = Type.Object(
  {
    id: Id,
    name: Type.String({ minLength: 1 }),
    version: Type.Integer({ minimum: 1, description: 'store-stamped, monotonic; every prior version is kept' }),
    description: Type.Optional(Type.String()),
    sessionId: Id,
    workspaceId: Id,
    items: Type.Array(TodoItem, { default: [] }),
  },
  { $id: 'TodoList', additionalProperties: false },
)
export type TodoList = Static<typeof TodoList>
