import type { WorkflowSpec } from '@openinfo/contracts'
import { WorkflowSpec as WorkflowSpecSchema } from '@openinfo/contracts'
import { Value } from '@sinclair/typebox/value'
import type { WorkspaceRegistry } from '../store/index.js'
import { DEFAULT_WORKFLOW_ID, loadDefaultWorkflow } from './defaults.js'

const WORKFLOW_KIND = 'workflow'

/**
 * Store-backed workflow documents, consistent with SurfaceDocuments/DistillDocuments: versioned config
 * records in _meta.db via LayoutStore. Seeds the shipped `workflow-default` (the behavior-identical
 * pipeline mirror) only when absent, so a user's edits are never clobbered.
 *
 * The executor reads `active()` FRESH per drain / per session-end (the flags/surfaces hot-edit pattern),
 * so a stored edit takes effect with NO engine restart. `save()` is the write half the GET/PUT
 * /workflows routes bind to (P4-T1): a validated, version-stamped edit lands in the SAME record the
 * executor reads next, so "the user composes the pipeline" over the API takes effect with no restart
 * and no executor change.
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

  /** Every stored workflow (latest version of each) — the GET /workflows enumeration read. Because the
   * shipped default is seeded on `ensureDefaults()`, the list always contains `workflow-default`. */
  list(): WorkflowSpec[] {
    return this.store.layouts.latestOfKind<WorkflowSpec>(WORKFLOW_KIND).map((doc) => doc.body)
  }

  /**
   * Persist an edited workflow, stamping `version` = latest stored version + 1 (LayoutStore keeps every
   * prior version — editable history), mirroring TodoDocuments.save / SurfaceDocuments.save. The body is
   * contract-validated against WorkflowSpec BEFORE write (the Tier-A gate, the last line of defense): the
   * `kind` union is CLOSED, so a step naming an unrunnable primitive — one the executor has no path for —
   * is rejected here rather than reaching the executor as a silent no-op (see the WorkflowStepKind
   * comment). A rejected write throws, which the PUT route maps to a 400.
   */
  save(spec: WorkflowSpec): WorkflowSpec {
    const current = this.store.layouts.getLatest<WorkflowSpec>(WORKFLOW_KIND, spec.id)
    const next: WorkflowSpec = { ...spec, version: (current?.body.version ?? 0) + 1 }
    if (!Value.Check(WorkflowSpecSchema, next)) {
      throw new Error(`workflow failed contract validation: ${spec.id}`)
    }
    this.store.layouts.put(WORKFLOW_KIND, spec.id, next)
    return next
  }
}
