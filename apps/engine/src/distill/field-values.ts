import type { FieldValue } from '@openinfo/contracts'
import { FieldValue as FieldValueSchema } from '@openinfo/contracts'
import { Value } from '@sinclair/typebox/value'
import type { WorkspaceRegistry } from '../store/index.js'

const FIELD_VALUE_KIND = 'field-value'

/** Stable causal identity of one field within one fast fan-out pass. */
const passKey = (value: FieldValue): string => {
  if (value.spanId !== undefined) return `span\u0000${value.spanId}\u0000${value.id}`
  return [
    'legacy',
    value.id,
    ...(value.provenance.sourceChunks ?? []).slice().sort(),
    value.provenance.windowStart ?? '',
    value.provenance.windowEnd ?? '',
  ].join('\u0000')
}

/**
 * Collapse document revisions from the same causal field pass (provisional → judged) into its most
 * advanced record, while preserving later fast passes that reused the deterministic FieldValue id. Input
 * from `history()` is oldest→newest; the judge-presence tie-break also makes pure callers robust to equal
 * timestamps. A fan-out span covers multiple fields, hence `passKey` includes the field document id.
 */
export const collapseFieldValuePasses = (versions: readonly FieldValue[]): FieldValue[] => {
  const byPass = new Map<string, FieldValue>()
  for (const value of versions) {
    const key = passKey(value)
    const current = byPass.get(key)
    const currentReviewed = current?.provenance.judge !== undefined
    const candidateReviewed = value.provenance.judge !== undefined
    if (
      current === undefined ||
      (candidateReviewed && !currentReviewed) ||
      (candidateReviewed === currentReviewed && current.updatedAt <= value.updatedAt)
    ) {
      byPass.set(key, value)
    }
  }
  return [...byPass.values()]
}

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

  /**
   * Every durable version for a workspace, oldest to newest within each field document. This is the
   * audit/trace read, not the product projection: a later fast pass reuses the deterministic FieldValue
   * id, so reading only `list()` would erase the earlier input's field + judge lineage. Consumers should
   * collapse versions that share one causal field pass (`spanId`, with a legacy source-window fallback)
   * while retaining later passes with a new span/source window.
   */
  history(workspaceId: string, sessionId?: string): FieldValue[] {
    return this.store.layouts
      .versionsOfKind<FieldValue>(FIELD_VALUE_KIND)
      .map((doc) => doc.body)
      .filter((v) => v.workspaceId === workspaceId && (sessionId === undefined || v.sessionId === sessionId || v.sessionId === undefined))
  }

  /** Audit-ready causal passes: full history, with only same-pass provisional/judge revisions collapsed. */
  passes(workspaceId: string, sessionId?: string): FieldValue[] {
    return collapseFieldValuePasses(this.history(workspaceId, sessionId))
  }
}
