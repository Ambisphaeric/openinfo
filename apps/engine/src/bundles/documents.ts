import type { Bundle } from '@openinfo/contracts'
import { Bundle as BundleSchema } from '@openinfo/contracts'
import { Value } from '@sinclair/typebox/value'
import type { WorkspaceRegistry } from '../store/index.js'
import { DEFAULT_BUNDLE_ID, loadDefaultBundle } from './defaults.js'

const BUNDLE_KIND = 'bundle'

/**
 * Store-backed app-bundle documents, consistent with SurfaceDocuments/WorkflowDocuments: versioned config
 * records in _meta.db via LayoutStore (the same document substrate its sibling doc kinds live in). Seeds
 * the shipped `bundle-standard-app` (the MVP Standard App) ONLY when absent, so a user's edits are never
 * clobbered.
 *
 * "Defaults are just documents we ship" — a bundle is a document like a surface or a workflow, so it gets
 * the same GET/PUT/version-history seams for free. `save()` is the write half the GET/PUT /bundles routes
 * bind to: a validated, version-stamped edit lands in the SAME record `get()` reads next. Read-fresh, so a
 * stored edit takes effect with no restart, mirroring WorkflowDocuments.
 */
export class BundleDocuments {
  constructor(private readonly store: WorkspaceRegistry) {}

  ensureDefaults(): void {
    if (!this.store.layouts.getLatest<Bundle>(BUNDLE_KIND, DEFAULT_BUNDLE_ID)) {
      this.store.layouts.put(BUNDLE_KIND, DEFAULT_BUNDLE_ID, loadDefaultBundle())
    }
  }

  /** The stored bundle for an id, falling back to the shipped default for its own id, else undefined. */
  get(id: string): Bundle | undefined {
    const stored = this.store.layouts.getLatest<Bundle>(BUNDLE_KIND, id)?.body
    if (stored) return stored
    return id === DEFAULT_BUNDLE_ID ? loadDefaultBundle() : undefined
  }

  /**
   * Every stored bundle (latest version of each) — the GET /bundles enumeration read. Because the shipped
   * Standard App is seeded on `ensureDefaults()`, the list always contains `bundle-standard-app`; the
   * defensive unshift keeps it listed even against a store somehow never seeded (mirrors SurfaceDocuments).
   */
  list(): Bundle[] {
    const stored = this.store.layouts.latestOfKind<Bundle>(BUNDLE_KIND).map((doc) => doc.body)
    if (!stored.some((b) => b.id === DEFAULT_BUNDLE_ID)) stored.unshift(loadDefaultBundle())
    return stored
  }

  /**
   * Persist an edited bundle, stamping `version` = latest stored version + 1 (LayoutStore keeps every prior
   * version — editable history), mirroring WorkflowDocuments.save / SurfaceDocuments.save. The body is
   * contract-validated against Bundle BEFORE write (the Tier-A gate, the last line of defense): the closed
   * face-kind / chat-source unions reject an unrunnable face role or ungatherable chat source AT WRITE TIME
   * rather than letting a wrong document persist. A rejected write throws, which the PUT route maps to a 400.
   */
  save(bundle: Bundle): Bundle {
    const current = this.store.layouts.getLatest<Bundle>(BUNDLE_KIND, bundle.id)
    const next: Bundle = { ...bundle, version: (current?.body.version ?? 0) + 1 }
    if (!Value.Check(BundleSchema, next)) {
      throw new Error(`bundle failed contract validation: ${bundle.id}`)
    }
    this.store.layouts.put(BUNDLE_KIND, bundle.id, next)
    return next
  }
}
