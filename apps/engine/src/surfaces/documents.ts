import type { Surface } from '@openinfo/contracts'
import type { WorkspaceRegistry } from '../store/index.js'
import { defaultHudSurface, SEEDED_SURFACES } from './defaults.js'
import { defaultPillSurface, PREVIOUS_DEFAULT_PILL_BODY } from './pill.js'
import { defaultNotetakerSurface, PREVIOUS_DEFAULT_NOTETAKER_BODY } from './notetaker.js'

const SURFACE_KIND = 'surface'

/**
 * Store-backed surface (HUD layout) documents, consistent with DistillDocuments/VoiceDocuments:
 * versioned records in _meta.db via LayoutStore (CODE_MAP homes "layouts (P2)" under store/). Seeds
 * every shipped default surface (SEEDED_SURFACES — the HUD + the #100 fields app) ONLY when absent, so a
 * user's edited layout is never clobbered. Surfaces are the first UI's single source of truth — the client
 * fetches one and renders it, and the tray Apps folder lists them (GET /layouts/surfaces → list()).
 */
export class SurfaceDocuments {
  constructor(private readonly store: WorkspaceRegistry) {}

  ensureDefaults(): void {
    for (const surface of SEEDED_SURFACES) {
      const existing = this.store.layouts.getLatest<Surface>(SURFACE_KIND, surface.id)
      if (!existing) {
        this.store.layouts.put(SURFACE_KIND, surface.id, surface)
        continue
      }
      // One narrowly-scoped seed refresh for #174: an existing install gets the live-lane pill organ only
      // when the stored record is provably the exact untouched v1 pill we shipped. Any user save advances
      // the LayoutStore record version; any direct customization changes the serialized body. Either signal
      // means the surface belongs to the user and remains untouched. The refresh itself becomes record v2,
      // while the new surface body carries its shipped version 2, so it cannot repeat.
      if (
        surface.id === defaultPillSurface.id &&
        existing.version === 1 &&
        JSON.stringify(existing.body) === PREVIOUS_DEFAULT_PILL_BODY
      ) {
        this.store.layouts.put(SURFACE_KIND, surface.id, defaultPillSurface)
      }
      // The #177/#211 note-taker rewire — same conservative one-time refresh as the pill above. An install
      // whose note-taker record is provably the exact untouched v1 seed gets the summary-hierarchy center +
      // session-history left rail; any user save (record version > 1) or customization (changed body) means
      // the surface is the user's and is left alone. The refresh is record v2 carrying shipped body v2, so it
      // cannot repeat.
      if (
        surface.id === defaultNotetakerSurface.id &&
        existing.version === 1 &&
        JSON.stringify(existing.body) === PREVIOUS_DEFAULT_NOTETAKER_BODY
      ) {
        this.store.layouts.put(SURFACE_KIND, surface.id, defaultNotetakerSurface)
      }
    }
  }

  /**
   * Every surface document (latest version of each), for the editor's enumeration and the tray Apps folder.
   * The shipped defaults are always seeded (ensureDefaults), so they appear alongside any user-created/cloned
   * surfaces; the defensive unshift keeps any seeded default listed even against a store somehow never seeded.
   */
  list(): Surface[] {
    const stored = this.store.layouts.latestOfKind<Surface>(SURFACE_KIND).map((doc) => doc.body)
    for (const seeded of SEEDED_SURFACES) {
      if (!stored.some((s) => s.id === seeded.id)) stored.unshift(seeded)
    }
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
