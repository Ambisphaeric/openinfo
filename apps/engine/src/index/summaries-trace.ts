import type { Summary, SummaryChild, SummaryLevel } from '@openinfo/contracts'
import type { WorkspaceRegistry } from '../store/index.js'

/**
 * The SUMMARY DERIVATION-PATH walker (#177 slice 2) — proves the acceptance criterion that RAW-MEDIA EXPIRY
 * does not break the path. A summary references only DURABLE derived records (lower summaries, distillates,
 * moments, packets, stt/ocr) by id, never raw bytes; those durable records in turn name the RAW capture
 * chunks (audio/frames) they were derived from — and raw capture is TRANSIENT (never persisted; it "expires
 * once distilled/understood", see store/workspaces.ts). So walking a summary down to its raw layer must stay
 * WALKABLE even though the raw evidence is gone: every node resolves either to a present durable record or to
 * an HONEST `expired` leaf ("no longer retained") — never a throw, never fabricated content.
 *
 * The walk is deterministic and read-only. It recurses through summary→summary child refs (cycle-guarded by a
 * visited set), resolves each leaf record by (record, id), and — for the records that name raw capture
 * (distillate/ocr `sourceChunks`, stt `chunkId`) — appends the raw chunk ids as `expired` leaves, since raw
 * capture is not retained. A durable record that is itself missing (a dangling ref) is ALSO reported `expired`
 * rather than crashing the walk, so a consumer (the route / a UI) always gets an honest, complete answer.
 */

/** Whether a referenced source resolved to a present record or is honestly gone. */
export type TraceSourceStatus = 'present' | 'expired'

/**
 * A ref as the trace displays it. It is the summary's `SummaryChild` for a derived record, PLUS the extra
 * `capture-chunk` record kind for the raw transient layer (which is not a summarizable input and so is not in
 * the SummaryChild contract) — the walker names it explicitly so the raw leaf is honest, not squeezed into a
 * durable-record kind it is not.
 */
export interface TraceRef {
  record: SummaryChild['record'] | 'capture-chunk'
  id: string
  at: string
  role?: SummaryChild['role']
  level?: SummaryLevel
}

/** One node in a summary's derivation trace — a ref, whether it resolved, and (for a summary) its own children. */
export interface SummaryTraceNode {
  ref: TraceRef
  status: TraceSourceStatus
  /** human-readable class when `expired` — e.g. "raw capture not retained", "source no longer retained". */
  reason?: string
  /** deeper trace for a summary child (its own children), or the raw-capture leaves of a distillate/ocr/stt record. */
  children?: SummaryTraceNode[]
}

export interface SummaryTrace {
  summaryId: string
  level: SummaryLevel
  /** the resolved child derivation nodes; ALWAYS present (a missing source is an honest `expired` node, not an omission). */
  nodes: SummaryTraceNode[]
  /** true ⇒ at least one referenced source has expired (raw capture gone, or a dangling durable ref) — disclosed, never hidden. */
  hasExpiredSource: boolean
}

/** A raw capture chunk id is never persisted — surface it as an honest expired leaf (the derivation path still holds). */
const rawChunkNode = (id: string, at: string): SummaryTraceNode => ({
  ref: { record: 'capture-chunk', id, at, role: 'evidence' },
  status: 'expired',
  reason: 'raw capture not retained after processing',
})

/** Resolve one durable record by (record, id) from the workspace store; undefined ⇒ it has expired / was pruned. */
const resolveRecord = (store: WorkspaceRegistry, workspaceId: string, record: SummaryChild['record'], id: string): Record<string, unknown> | undefined => {
  switch (record) {
    case 'summary':
      return store.listSummaries(workspaceId, { includeSuperseded: true }).find((s) => s.id === id)
    case 'distillate':
      return store.listDistillates(workspaceId).find((d) => d.id === id)
    case 'context-packet':
      return store.listContextPackets(workspaceId, { includeSuperseded: true }).find((p) => p.id === id)
    case 'moment':
      return store.listMoments(workspaceId).find((m) => m.id === id)
    case 'stt-segment':
      return store.listSttSegments(workspaceId).find((s) => s.id === id)
    case 'ocr-result':
      return store.listOcrResults(workspaceId).find((o) => o.id === id)
    default:
      return undefined
  }
}

/** The raw-capture chunk ids a durable record was derived from (transient, never retained) — else none. */
const rawSourcesOf = (record: SummaryChild['record'], resolved: Record<string, unknown>): string[] => {
  if (record === 'distillate' || record === 'ocr-result') return (resolved['sourceChunks'] as string[] | undefined) ?? []
  if (record === 'stt-segment') return typeof resolved['chunkId'] === 'string' ? [resolved['chunkId'] as string] : []
  return []
}

const walkNode = (store: WorkspaceRegistry, workspaceId: string, ref: SummaryChild, visited: Set<string>): SummaryTraceNode => {
  const resolved = resolveRecord(store, workspaceId, ref.record, ref.id)
  if (resolved === undefined) return { ref, status: 'expired', reason: 'source no longer retained' }

  // A lower summary: recurse into ITS children (cycle-guarded), so the whole summary→…→leaf path is walkable.
  if (ref.record === 'summary') {
    if (visited.has(ref.id)) return { ref, status: 'present' }
    visited.add(ref.id)
    const child = resolved as unknown as Summary
    return { ref, status: 'present', children: child.children.map((c) => walkNode(store, workspaceId, c, visited)) }
  }

  // A durable leaf record: present — its RAW capture chunks are the transient layer, appended as expired leaves.
  const raw = rawSourcesOf(ref.record, resolved)
  return raw.length > 0
    ? { ref, status: 'present', children: raw.map((id) => rawChunkNode(id, ref.at)) }
    : { ref, status: 'present' }
}

/** Walk a summary's derivation path. Read-only, never throws; a missing source is an honest `expired` node. */
export const walkSummaryTrace = (store: WorkspaceRegistry, workspaceId: string, summary: Summary): SummaryTrace => {
  const visited = new Set<string>([summary.id])
  const nodes = summary.children.map((c) => walkNode(store, workspaceId, c, visited))
  const hasExpired = (list: SummaryTraceNode[]): boolean => list.some((n) => n.status === 'expired' || (n.children !== undefined && hasExpired(n.children)))
  return { summaryId: summary.id, level: summary.level, nodes, hasExpiredSource: hasExpired(nodes) }
}
