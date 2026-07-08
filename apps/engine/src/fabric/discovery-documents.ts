import type { CapabilityMap, ProbeList } from '@openinfo/contracts'
import type { WorkspaceRegistry } from '../store/index.js'
import { seededCapabilityMap, seededProbeList } from './discovery-defaults.js'

const PROBE_KIND = 'discovery-probes'
const MAP_KIND = 'capability-map'

/**
 * Store-backed discovery documents — the probe list + capability map — consistent with
 * FabricProfiles/DistillDocuments/SurfaceDocuments: versioned config records in _meta.db via
 * LayoutStore, seeded only when absent (never clobbers a user edit). Only this class touches these
 * documents; discovery (fabric/discover.ts) is handed the read values. A user on a nonstandard port
 * edits the stored probe list; a user with an unusual model-naming scheme edits the stored map — the
 * engine reads whatever is stored. Falls back to the seeded default if a document is somehow missing.
 */
export class DiscoveryDocuments {
  constructor(private readonly store: WorkspaceRegistry) {}

  ensureDefaults(): void {
    if (!this.store.layouts.getLatest<ProbeList>(PROBE_KIND, seededProbeList.id)) {
      this.store.layouts.put(PROBE_KIND, seededProbeList.id, seededProbeList)
    }
    if (!this.store.layouts.getLatest<CapabilityMap>(MAP_KIND, seededCapabilityMap.id)) {
      this.store.layouts.put(MAP_KIND, seededCapabilityMap.id, seededCapabilityMap)
    }
  }

  probeList(): ProbeList {
    return this.store.layouts.getLatest<ProbeList>(PROBE_KIND, seededProbeList.id)?.body ?? seededProbeList
  }

  capabilityMap(): CapabilityMap {
    return this.store.layouts.getLatest<CapabilityMap>(MAP_KIND, seededCapabilityMap.id)?.body ?? seededCapabilityMap
  }
}
