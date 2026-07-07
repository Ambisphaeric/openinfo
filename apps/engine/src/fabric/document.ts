import type { Fabric } from '@openinfo/contracts'
import type { WorkspaceRegistry } from '../store/index.js'

const emptySlots = {
  stt: [],
  tts: [],
  llm: [],
  vlm: [],
  ocr: [],
  embed: [],
}

export const defaultFabric = (): Fabric => ({ slots: { ...emptySlots } })

export class FabricDocuments {
  constructor(private readonly store: WorkspaceRegistry) {}

  load(): Fabric {
    return this.store.layouts.getLatest<Fabric>('config', 'fabric')?.body ?? defaultFabric()
  }

  save(fabric: Fabric): Fabric {
    this.store.layouts.put('config', 'fabric', fabric)
    return fabric
  }
}
