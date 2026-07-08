import type { Fabric } from '@openinfo/contracts'
import type { WorkspaceRegistry } from '../store/index.js'
import { FabricProfiles } from './profiles.js'

const emptySlots = {
  stt: [],
  tts: [],
  llm: [],
  vlm: [],
  ocr: [],
  embed: [],
}

export const defaultFabric = (): Fabric => ({ slots: { ...emptySlots } })

/**
 * The active-fabric VIEW over profiles (the live fabric IS a profile — see ARCHITECTURE §8 design
 * note). `load()` returns the active profile's map; with no active profile it falls back to the
 * pre-profiles single fabric doc (backward compat) and then to an empty map. `save()` edits the live
 * fabric: with a profile active it edits THAT profile in place (bumping its version); otherwise it
 * writes the legacy single doc. This keeps GET/PUT /fabric working exactly as before for callers
 * that never touch profiles. Profile CRUD/activate go through `.profiles`.
 */
export class FabricDocuments {
  readonly profiles: FabricProfiles

  constructor(private readonly store: WorkspaceRegistry) {
    this.profiles = new FabricProfiles(store)
  }

  /** Seed the example profiles (inert until activated) — does not change what `load()` returns. */
  ensureDefaults(): void {
    this.profiles.ensureDefaults()
  }

  load(): Fabric {
    const active = this.profiles.active()
    if (active) return active.fabric
    return this.store.layouts.getLatest<Fabric>('config', 'fabric')?.body ?? defaultFabric()
  }

  save(fabric: Fabric): Fabric {
    const active = this.profiles.active()
    if (active) {
      this.profiles.save({ ...active, fabric })
      return fabric
    }
    this.store.layouts.put('config', 'fabric', fabric)
    return fabric
  }
}
