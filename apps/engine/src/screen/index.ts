import { EventBus, type EngineEvents } from '../bus/index.js'
import { FabricDocuments, FileSecretStore } from '../fabric/index.js'
import { WorkspaceRegistry, resolveSecretsPath } from '../store/index.js'
import { isFlagEnabled } from '../flags/read.js'
import { ScreenOcrProcessor, type ScreenOcrInvoke } from './processor.js'
import { registerScreenProcessor } from './registry.js'

export { ScreenOcrProcessor, type ScreenOcrInvoke, type ScreenOcrProcessorDeps } from './processor.js'
export { handleScreen, type ScreenRouterContext } from './router.js'
export { getScreenProcessor, registerScreenProcessor } from './registry.js'

/** The engine surface wireScreenOcr needs — EngineApp is structurally compatible ({ bus, store, … }). */
export interface ScreenWiringApp {
  bus: EventBus<EngineEvents>
  store: WorkspaceRegistry
}

export interface ScreenWiringOptions {
  log?: (message: string) => void
  /** test seam — a fake OCR invoke standing in for the fabric ocr slot (no server needed). */
  invoke?: ScreenOcrInvoke
}

/**
 * Wire the screen-OCR processor onto a running engine (main.ts calls this after createEngineApp; tests
 * construct the same wiring explicitly). It reconstructs the FabricDocuments + FileSecretStore over the
 * app's store EXACTLY as http.ts does (same DB, so `fabric.load()` sees the same active profile / live
 * fabric, and the secret resolver reads the same chmod-600 store), then subscribes the processor to
 * `capture.received` and publishes its output on the app bus: `distillate.updated` (so the standard WS
 * feed + surfaces see the screen text) and the engine-internal `ocr.completed` (the raw result).
 *
 * The subscription is FIRE-AND-FORGET (`void process(chunk)`): process() never throws, and returning void
 * keeps bus.publish('capture.received') — which awaits its subscribers on the ingest path — from blocking
 * on, or failing over, a slow/erroring OCR pass. No LocalRuntimeManager is constructed here (a managed
 * local ocr/vlm runtime is future — invokeOcr falls through `local` endpoints gracefully; http paddle-
 * serving and openai-compat endpoints need none). Returns the processor (the router reads its status).
 */
export const wireScreenOcr = (app: ScreenWiringApp, options: ScreenWiringOptions = {}): ScreenOcrProcessor => {
  const fabric = new FabricDocuments(app.store)
  const secrets = new FileSecretStore(resolveSecretsPath(app.store.dataDir))
  const processor = new ScreenOcrProcessor({
    store: app.store,
    fabric,
    isEnabled: () => isFlagEnabled(app.store, 'screen.ocr'),
    resolveKey: (ref) => secrets.resolve(ref),
    publishDistillate: (distillate) => app.bus.publish('distillate.updated', distillate),
    publishOcr: (result) => app.bus.publish('ocr.completed', result),
    ...(options.log ? { log: options.log } : {}),
    ...(options.invoke ? { invoke: options.invoke } : {}),
  })
  registerScreenProcessor(app.store, processor)
  app.bus.subscribe('capture.received', (chunk) => {
    void processor.process(chunk)
  })
  return processor
}
