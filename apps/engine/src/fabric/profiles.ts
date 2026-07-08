import type { FabricProfile } from '@openinfo/contracts'
import type { WorkspaceRegistry } from '../store/index.js'
import { seededProfiles } from './defaults.js'

const PROFILE_KIND = 'fabric-profile'
const CONFIG_KIND = 'config'
const ACTIVE_KEY = 'active-profile'

interface ActivePointer {
  profileId: string
}

/**
 * Store-backed fabric profiles + the single "active profile" pointer, consistent with
 * SurfaceDocuments/VoiceDocuments: versioned documents in _meta.db via LayoutStore (cloning is
 * copying a document; every prior version is kept). The ACTIVE profile is the live fabric —
 * FabricDocuments.load() reads it; activating swaps what invoke/health/bench run against. Seeds the
 * example profiles only when absent (never clobbers a user's edit) and leaves them inert (no profile
 * is auto-activated, so GET /fabric is unchanged until a user opts in). Only this class and
 * FabricDocuments touch profile documents; the API asks it to read/write (never opens the DB itself).
 */
export class FabricProfiles {
  constructor(private readonly store: WorkspaceRegistry) {}

  ensureDefaults(): void {
    for (const profile of seededProfiles) {
      if (!this.store.layouts.getLatest<FabricProfile>(PROFILE_KIND, profile.id)) {
        this.store.layouts.put(PROFILE_KIND, profile.id, profile)
      }
    }
  }

  /** All profiles (latest version of each), id-ordered. */
  list(): FabricProfile[] {
    return this.store.layouts.latestOfKind<FabricProfile>(PROFILE_KIND).map((doc) => doc.body)
  }

  get(id: string): FabricProfile | undefined {
    return this.store.layouts.getLatest<FabricProfile>(PROFILE_KIND, id)?.body
  }

  /**
   * Persist a profile, stamping `version` = latest stored version + 1 (never clobber; LayoutStore
   * keeps every prior version — cloneable history). `createdAt` is preserved from the first save.
   */
  save(profile: FabricProfile): FabricProfile {
    const current = this.store.layouts.getLatest<FabricProfile>(PROFILE_KIND, profile.id)
    const next: FabricProfile = {
      ...profile,
      version: (current?.body.version ?? 0) + 1,
      createdAt: current?.body.createdAt ?? profile.createdAt ?? new Date().toISOString(),
    }
    this.store.layouts.put(PROFILE_KIND, profile.id, next)
    return next
  }

  /** Remove a profile (all versions). Returns whether it existed. */
  delete(id: string): boolean {
    return this.store.layouts.delete(PROFILE_KIND, id)
  }

  /**
   * Clone a profile under a new id (cloning is copying a document). The clone starts at version 1
   * with its own name; the source's fabric map (including any keyRefs — never key values) is copied
   * verbatim. Returns undefined if the source does not exist.
   */
  clone(sourceId: string, newId: string, newName?: string): FabricProfile | undefined {
    const source = this.get(sourceId)
    if (!source) return undefined
    const clone: FabricProfile = {
      id: newId,
      name: newName ?? `${source.name} (copy)`,
      version: 1,
      fabric: source.fabric,
      ...(source.description !== undefined ? { description: source.description } : {}),
    }
    return this.save(clone)
  }

  /** The active profile's id (the live-fabric pointer), or undefined if none is active. */
  activeId(): string | undefined {
    const id = this.store.layouts.getLatest<ActivePointer>(CONFIG_KIND, ACTIVE_KEY)?.body.profileId
    return id ? id : undefined
  }

  /** The active profile document (the live fabric), or undefined. */
  active(): FabricProfile | undefined {
    const id = this.activeId()
    return id ? this.get(id) : undefined
  }

  /** Point the active pointer at a profile; returns it, or undefined if the id is unknown. */
  activate(id: string): FabricProfile | undefined {
    const profile = this.get(id)
    if (!profile) return undefined
    this.store.layouts.put<ActivePointer>(CONFIG_KIND, ACTIVE_KEY, { profileId: id })
    return profile
  }

  /** Clear the active pointer (the live fabric reverts to the legacy/empty map). */
  deactivate(): void {
    this.store.layouts.put<ActivePointer>(CONFIG_KIND, ACTIVE_KEY, { profileId: '' })
  }
}
