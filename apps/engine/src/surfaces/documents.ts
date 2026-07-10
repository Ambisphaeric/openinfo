import type { Surface } from '@openinfo/contracts'
import type { WorkspaceRegistry } from '../store/index.js'
import { defaultHudSurface, defaultDiagnosticsSurface } from './defaults.js'

const SURFACE_KIND = 'surface'

/**
 * Store-backed surface (HUD layout) documents, consistent with DistillDocuments/VoiceDocuments:
 * versioned records in _meta.db via LayoutStore (CODE_MAP homes "layouts (P2)" under store/). Seeds
 * the shipped openinfo HUD only when absent, so a user's edited layout is never clobbered. Surfaces
 * are the first UI's single source of truth — the client fetches one and renders it.
 */
export class SurfaceDocuments {
  constructor(private readonly store: WorkspaceRegistry) {}

  ensureDefaults(): void {
    for (const doc of [defaultHudSurface, defaultDiagnosticsSurface]) {
      if (!this.store.layouts.getLatest<Surface>(SURFACE_KIND, doc.id)) {
        this.store.layouts.put(SURFACE_KIND, doc.id, doc)
      }
    }
  }

  /**
   * Every surface document (latest version of each), for the editor's enumeration. The shipped HUD is
   * always seeded (ensureDefaults), so it appears alongside any user-created/cloned surfaces; the
   * defensive unshift keeps it listed even against a store that was somehow never seeded.
   */
  list(): Surface[] {
    const stored = this.store.layouts.latestOfKind<Surface>(SURFACE_KIND).map((doc) => doc.body)
    if (!stored.some((s) => s.id === defaultHudSurface.id)) stored.unshift(defaultHudSurface)
    return stored
  }

  /** The stored surface for an id, falling back to the shipped default for its own id, else undefined. */
  get(id: string): Surface | undefined {
    const stored = this.store.layouts.getLatest<Surface>(SURFACE_KIND, id)?.body
    if (stored) return stored
    return id === defaultHudSurface.id ? defaultHudSurface : undefined
  }

  /**
   * Persist a surface document, stamping `version` = latest stored version + 1 so GET returns a
   * monotonically increasing version (the LayoutStore keeps every prior version — cloneable history).
   * The body is validated by the route before it reaches here.
   */
  save(surface: Surface): Surface {
    const current = this.store.layouts.getLatest<Surface>(SURFACE_KIND, surface.id)
    const next: Surface = { ...surface, version: (current?.body.version ?? 0) + 1 }
    this.store.layouts.put(SURFACE_KIND, surface.id, next)
    return next
  }
}
