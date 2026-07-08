import type { StarterModel, StarterModels } from '@openinfo/contracts'
import type { WorkspaceRegistry } from '../store/index.js'
import { seededStarterModels } from './local-defaults.js'

const STARTER_KIND = 'starter-models'

/**
 * Store-backed starter-models document — consistent with DiscoveryDocuments/FabricProfiles: a versioned
 * config record in _meta.db via LayoutStore, seeded only when absent (never clobbers a user edit). Only
 * this class touches the document; the model store is handed `models()`. A user can edit the stored
 * catalog (add a model, change a URL) without a code change. Falls back to the seeded default if missing.
 */
export class StarterModelsDocuments {
  constructor(private readonly store: WorkspaceRegistry) {}

  ensureDefaults(): void {
    if (!this.store.layouts.getLatest<StarterModels>(STARTER_KIND, seededStarterModels.id)) {
      this.store.layouts.put(STARTER_KIND, seededStarterModels.id, seededStarterModels)
    }
  }

  models(): StarterModel[] {
    return (this.store.layouts.getLatest<StarterModels>(STARTER_KIND, seededStarterModels.id)?.body ?? seededStarterModels).models
  }
}
