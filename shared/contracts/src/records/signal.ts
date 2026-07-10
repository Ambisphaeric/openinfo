import { Type, type Static } from '@sinclair/typebox'
import { Id, IsoTime } from '../common.js'

/**
 * What a per-row glyph verb records about ONE hydrated item (#66). A `dismiss` signal is the
 * SUPPRESSION record — dismissing an item persists this so queries exclude it and it stays dismissed
 * across reloads (the verb was honestly-inert until this slice gave it a write path). `follow-up` is
 * the mark-for-follow-up signal, persisted in the SAME store so it lands somewhere queryable without
 * fabricating a Pin or a cross-session to-do. Append-only: a new signal kind is an added literal here.
 */
export const ItemSignalKind = Type.Union(
  ['dismiss', 'follow-up'].map((k) => Type.Literal(k)),
  { $id: 'ItemSignalKind', description: 'dismiss = suppression (queries exclude); follow-up = flagged for later (queryable)' },
)
export type ItemSignalKind = Static<typeof ItemSignalKind>

/**
 * A user signal on one hydrated row — the persisted substance behind the dismiss / mark-for-follow-up
 * glyph verbs. Keyed by (workspaceId, source, itemId): a signal names WHICH query source the item came
 * from and its stable id, so a `dismiss` signal for `todos:t1` suppresses that to-do without touching a
 * same-id row from another source. `at` is SERVER-stamped (the write route stamps it — timestamps are
 * never client-controlled, per the store's record convention). Idempotent per (source, itemId, kind).
 */
export const ItemSignal = Type.Object(
  {
    workspaceId: Id,
    source: Type.String({ minLength: 1, description: 'the query source the item came from (todos, relevant-now, moments, entities, pins, drafts, distillates, ledger)' }),
    itemId: Id,
    kind: ItemSignalKind,
    at: IsoTime,
  },
  { $id: 'ItemSignal', additionalProperties: false, description: 'the app records the user’s dismiss/follow-up; it never sends or commits anything outward' },
)
export type ItemSignal = Static<typeof ItemSignal>
