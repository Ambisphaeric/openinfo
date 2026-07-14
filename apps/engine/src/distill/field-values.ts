import type { FieldValue } from '@openinfo/contracts'
import { FieldValue as FieldValueSchema } from '@openinfo/contracts'
import { Value } from '@sinclair/typebox/value'
import type { WorkspaceRegistry } from '../store/index.js'

const FIELD_VALUE_KIND = 'field-value'

/**
 * Audit/Trace surfaces show at most 100 passes / 30 roots. Ten persisted revisions for every potentially
 * visible field pass leaves ample room for producer + judge history without making Settings scan an
 * unbounded lifetime of field updates synchronously.
 */
export const FIELD_VALUE_HISTORY_VERSION_LIMIT = 1_000

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

/** One causal fast-field pass reconstructed from its append-only document revisions. */
export interface FieldValuePassHistory {
  /** The first persisted producer row — its value, time, endpoint and usage are never overwritten by review. */
  producer: FieldValue
  /** The most recently appended row, independent of wall-clock movement. */
  latest: FieldValue
  /** Every judge-stamped revision in persisted append order; no retry identity exists to deduplicate them. */
  reviews: FieldValue[]
}

/**
 * Reconstruct causal passes from persisted oldest-to-newest rows. This intentionally trusts append order,
 * not `updatedAt`: a system-clock correction cannot make an older document version replace a later one.
 * A span is authoritative for modern records. For legacy rows, every newly appended non-judge producer
 * starts a generation and following judge rows attach to that generation; this preserves two historical
 * producer→judge passes even when their deterministic id/source/window tuple is identical.
 */
export const groupFieldValuePasses = (versions: readonly FieldValue[]): FieldValuePassHistory[] => {
  const byPass = new Map<string, FieldValuePassHistory>()
  const ordered: FieldValuePassHistory[] = []
  const legacyGeneration = new Map<string, number>()
  for (const value of versions) {
    const baseKey = passKey(value)
    let key = baseKey
    if (value.spanId === undefined) {
      const generation = legacyGeneration.get(baseKey) ?? 0
      if (value.provenance.judge === undefined) {
        key = `${baseKey}\u0000generation\u0000${generation + 1}`
        legacyGeneration.set(baseKey, generation + 1)
      } else {
        const currentGeneration = Math.max(1, generation)
        key = `${baseKey}\u0000generation\u0000${currentGeneration}`
        // A bounded history can begin at a judge row. Record that inferred generation so the next producer
        // starts a new one instead of being folded backward into the truncated review-only pass.
        legacyGeneration.set(baseKey, currentGeneration)
      }
    }
    let pass = byPass.get(key)
    if (pass === undefined) {
      pass = { producer: value, latest: value, reviews: [] }
      byPass.set(key, pass)
      ordered.push(pass)
    } else {
      pass.latest = value
    }
    // Every judge-stamped document version is evidence of a persisted review revision. There is no
    // retry-id proving two identical-looking rows are duplicates, so append order must retain them both.
    if (value.provenance.judge !== undefined) pass.reviews.push(value)
  }
  return ordered
}

/**
 * Collapse document revisions from the same causal field pass (provisional → judged) into its most
 * recently appended record, while preserving later fast passes that reused the deterministic FieldValue
 * id. Input from `history()` is oldest→newest; document order is authoritative even when the system clock
 * moves backward. A fan-out span covers multiple fields, hence `passKey` includes the field document id.
 */
export const collapseFieldValuePasses = (versions: readonly FieldValue[]): FieldValue[] =>
  groupFieldValuePasses(versions).map((pass) => pass.latest)

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
   * The most recent bounded durable versions for a workspace, in global persisted append order. This is
   * the audit/trace read, not the product projection: a later fast pass reuses the deterministic FieldValue
   * id, so reading only `list()` would erase the earlier input's field + judge lineage. Consumers should
   * collapse versions that share one causal field pass (`spanId`, with a legacy source-window fallback)
   * while retaining later passes with a new span/source window.
   */
  history(workspaceId: string, sessionId?: string, maxVersions = FIELD_VALUE_HISTORY_VERSION_LIMIT): FieldValue[] {
    return this.store.layouts
      .recentVersionsOfKindByScope<FieldValue>(FIELD_VALUE_KIND, workspaceId, sessionId, maxVersions)
      .map((doc) => doc.body)
      .filter((v) => v.workspaceId === workspaceId && (sessionId === undefined || v.sessionId === sessionId || v.sessionId === undefined))
  }

  /** Audit-ready causal passes from bounded recent history, with same-pass document revisions collapsed. */
  passes(workspaceId: string, sessionId?: string): FieldValue[] {
    return collapseFieldValuePasses(this.history(workspaceId, sessionId))
  }
}
