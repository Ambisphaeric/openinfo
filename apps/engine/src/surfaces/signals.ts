import type { ItemSignal, ItemSignalKind } from '@openinfo/contracts'
import { ItemSignal as ItemSignalSchema } from '@openinfo/contracts'
import { Value } from '@sinclair/typebox/value'
import type { WorkspaceRegistry } from '../store/index.js'

const SIGNAL_KIND = 'item-signals'

/** The stored document body: one per workspace, the append-only log of a workspace's row signals. */
interface SignalDoc {
  workspaceId: string
  signals: ItemSignal[]
}

/** The (source, itemId) match key — a signal is scoped to the source it was raised from. */
const signalKey = (source: string, itemId: string): string => `${source}:${itemId}`

/**
 * Store-backed per-item user signals (#66) — the SUPPRESSION store the dismiss verb writes to, plus the
 * mark-for-follow-up flag, in ONE document per workspace. Consistent with TodoDocuments/HintsDocuments:
 * a versioned document in _meta.db via LayoutStore, keyed by workspaceId (NOT a per-workspace record DB —
 * a signal is a config-shaped document, and the workspace DB need not exist yet). Idempotent per
 * (source, itemId, kind): re-dismissing an already-dismissed item is a no-op, so a double-click never
 * duplicates. The body is contract-validated before write (last line of defense, like saveMoment).
 */
export class ItemSignalStore {
  constructor(private readonly store: WorkspaceRegistry) {}

  /** Every signal recorded for a workspace (latest version of its document), or [] if none yet. */
  list(workspaceId: string): ItemSignal[] {
    return this.store.layouts.getLatest<SignalDoc>(SIGNAL_KIND, workspaceId)?.body.signals ?? []
  }

  /**
   * Record a signal, stamping nothing (the route already stamped `at`) beyond de-duplication. A signal
   * whose (source, itemId, kind) already exists is dropped — the log stays one-entry-per-fact. Validates
   * the record against the contract before persisting. Returns the (possibly pre-existing) signal.
   */
  add(signal: ItemSignal): ItemSignal {
    const { workspaceId, source, itemId, kind } = signal
    if (!Value.Check(ItemSignalSchema, signal)) {
      throw new Error(`item signal failed contract validation: ${kind} ${source}:${itemId}`)
    }
    const current = this.list(workspaceId)
    const exists = current.some((s) => s.source === source && s.itemId === itemId && s.kind === kind)
    if (!exists) {
      this.store.layouts.put<SignalDoc>(SIGNAL_KIND, workspaceId, { workspaceId, signals: [...current, signal] })
    }
    return signal
  }

  /** The set of `${source}:${itemId}` keys a workspace has a signal of `kind` for — the query filter input. */
  keysOfKind(workspaceId: string, kind: ItemSignalKind): Set<string> {
    return new Set(this.list(workspaceId).filter((s) => s.kind === kind).map((s) => signalKey(s.source, s.itemId)))
  }

  /** The suppressed-item keys (`dismiss` signals) a workspace holds — what compileQuery filters against. */
  dismissedKeys(workspaceId: string): Set<string> {
    return this.keysOfKind(workspaceId, 'dismiss')
  }
}
