import type { WorkspaceHints } from '@openinfo/contracts'
import type { WorkspaceRegistry } from '../store/index.js'

const HINTS_KIND = 'workspace-hints'

/**
 * Store-backed attribution-hints documents (Phase 3 context-switch detection), consistent with
 * ActDocuments/DistillDocuments: versioned config records in _meta.db under the `workspace-hints`
 * kind, keyed by workspaceId. Editable via the same versioned document mechanism as modes/registers.
 *
 * Seeding decision (v0): only an EMPTY hints doc for the default workspace (`patterns: []`) is seeded,
 * and only when absent (a user's edits are never clobbered). Empty patterns match nothing, so with the
 * shipped default an unmatched focus signal takes NO action — there is deliberately NO permissive
 * catch-all, which would attribute everything to `default` and defeat detection. Real hints are added
 * per workspace by editing the document (in v0, via `put` at the store layer — an HTTP editing route is
 * a later slice, matching the "the API is the slice" discipline elsewhere).
 */
export class HintsDocuments {
  constructor(private readonly store: WorkspaceRegistry) {}

  ensureDefaults(): void {
    if (!this.store.layouts.getLatest<WorkspaceHints>(HINTS_KIND, 'default')) {
      const seed: WorkspaceHints = { workspaceId: 'default', patterns: [] }
      this.store.layouts.put(HINTS_KIND, 'default', seed)
    }
  }

  /** Every workspace's latest hints document — the detector scores signals against all of them. */
  all(): WorkspaceHints[] {
    return this.store.layouts.latestOfKind<WorkspaceHints>(HINTS_KIND).map((doc) => doc.body)
  }

  get(workspaceId: string): WorkspaceHints | undefined {
    return this.store.layouts.getLatest<WorkspaceHints>(HINTS_KIND, workspaceId)?.body
  }

  put(hints: WorkspaceHints): WorkspaceHints {
    return this.store.layouts.put(HINTS_KIND, hints.workspaceId, hints).body
  }
}
