import type { WorkflowSpec } from '@openinfo/contracts'
import type { WorkspaceRegistry } from '../store/index.js'
import { DEFAULT_WORKFLOW_ID, loadDefaultWorkflow } from './defaults.js'

const WORKFLOW_KIND = 'workflow'

/**
 * Store-backed workflow documents, consistent with SurfaceDocuments/DistillDocuments: versioned config
 * records in _meta.db via LayoutStore. Seeds the shipped `workflow-default` (the behavior-identical
 * pipeline mirror) only when absent, so a user's edits are never clobbered.
 *
 * The executor reads `active()` FRESH per drain / per session-end (the flags/surfaces hot-edit pattern),
 * so a future edit takes effect with NO engine restart. This slice ships no edit ROUTE (deferred, see
 * PHASE4-NOTES) — the document is read-only from the seed for now — but the read seam is already the
 * hot-editable one, so a GET/PUT /workflows resource route drops in later with no executor change.
 */
export class WorkflowDocuments {
  constructor(private readonly store: WorkspaceRegistry) {}

  ensureDefaults(): void {
    if (!this.store.layouts.getLatest<WorkflowSpec>(WORKFLOW_KIND, DEFAULT_WORKFLOW_ID)) {
      this.store.layouts.put(WORKFLOW_KIND, DEFAULT_WORKFLOW_ID, loadDefaultWorkflow())
    }
  }

  /** The workflow the executor runs. v0: the shipped default, read fresh (hot-editable) with a code fallback. */
  active(): WorkflowSpec {
    return this.get(DEFAULT_WORKFLOW_ID) ?? loadDefaultWorkflow()
  }

  /** The stored workflow for an id, falling back to the shipped default for its own id, else undefined. */
  get(id: string): WorkflowSpec | undefined {
    const stored = this.store.layouts.getLatest<WorkflowSpec>(WORKFLOW_KIND, id)?.body
    if (stored) return stored
    return id === DEFAULT_WORKFLOW_ID ? loadDefaultWorkflow() : undefined
  }
}
