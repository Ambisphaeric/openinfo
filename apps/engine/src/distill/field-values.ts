import type { FieldValue } from '@openinfo/contracts'
import { FieldValue as FieldValueSchema } from '@openinfo/contracts'
import { Value } from '@sinclair/typebox/value'
import type { WorkspaceRegistry } from '../store/index.js'

const FIELD_VALUE_KIND = 'field-value'

/**
 * The DURABLE half of the fast-field substrate (#61): the latest value of each fast field, persisted as
 * a small config-shaped DOCUMENT in _meta.db via LayoutStore — the cheapest honest store shape for "the
 * current value of a field." Consistent with ItemSignalStore/TodoDocuments (a versioned document keyed
 * by a deterministic id, NOT a per-workspace record DB — a field value is config-shaped and the workspace
 * DB need not exist yet). Each `put` appends a version, so LayoutStore.getLatest IS the field's current
 * value AND the edit history is kept for free.
 *
 * The document id encodes the field's SCOPE so a session-scoped and a workspace-scoped value of the same
 * field never collide: `fv:<workspace>:<session>:<field>` for session scope, `fv:<workspace>::<field>`
 * (empty session segment) for workspace scope. The id IS the FieldValue.id the scheduler stamps.
 */
export class FieldValueStore {
  constructor(private readonly store: WorkspaceRegistry) {}

  /** The deterministic document id for a field value — session-scoped when `sessionId` is given. */
  static idFor(workspaceId: string, fieldId: string, sessionId?: string): string {
    return `fv:${workspaceId}:${sessionId ?? ''}:${fieldId}`
  }

  /**
   * Persist the latest value of a field (a new version each call — read-fresh + history). Contract-
   * validated BEFORE write (the belt-and-suspenders Tier-A gate, mirroring saveMoment/ItemSignalStore.add)
   * so a malformed value never lands. Returns the stored value.
   */
  put(value: FieldValue): FieldValue {
    // Capture id/fieldId BEFORE Value.Check — its type guard narrows `value` to `never` in the throw
    // branch (the WorkflowDocuments.save / DistillDocuments.saveTemplate precedent, PHASE4-NOTES #23).
    const { id, fieldId } = value
    if (!Value.Check(FieldValueSchema, value)) {
      throw new Error(`field value failed contract validation: ${fieldId} (${id})`)
    }
    this.store.layouts.put<FieldValue>(FIELD_VALUE_KIND, id, value)
    return value
  }

  /** The current value of one field (latest version), or undefined if it has never been produced. */
  latest(workspaceId: string, fieldId: string, sessionId?: string): FieldValue | undefined {
    return this.store.layouts.getLatest<FieldValue>(FIELD_VALUE_KIND, FieldValueStore.idFor(workspaceId, fieldId, sessionId))?.body
  }

  /**
   * Every current field value for a workspace (latest version of each), narrowed to a session when
   * `sessionId` is given — a session query returns that session's field values PLUS the workspace-scoped
   * ones (workspace-scoped values apply across sessions, e.g. accumulated vocabulary). No session filter
   * (a whole-workspace query) returns every value for the workspace. Unknown workspace / none produced yet
   * reads as [] — explainable-empty, never an error (mirrors ItemSignalStore.list / store.listTodos).
   */
  list(workspaceId: string, sessionId?: string): FieldValue[] {
    return this.store.layouts
      .latestOfKind<FieldValue>(FIELD_VALUE_KIND)
      .map((doc) => doc.body)
      .filter((v) => v.workspaceId === workspaceId && (sessionId === undefined || v.sessionId === sessionId || v.sessionId === undefined))
  }
}
