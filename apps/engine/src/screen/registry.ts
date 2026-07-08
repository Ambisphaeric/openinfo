import type { ScreenOcrProcessor } from './processor.js'

/**
 * The bridge between the screen router (invoked from http.ts's handler with only the HandlerContext) and
 * the screen processor (constructed in the wiring, AFTER createEngineApp built that context). The
 * processor holds in-memory status the router must read; there is no room on the context for it (that
 * file is P4A-owned — one mount line only). Keyed by the WorkspaceRegistry instance, which uniquely
 * identifies an engine app, so a router call resolves the processor wired onto the same app. A WeakMap so
 * a closed app's processor is collectable. When no processor is registered (a bare createEngineApp with no
 * wireScreenOcr — e.g. a test hitting /screen without the wiring), the router falls back to a zeroed status.
 */
const registry = new WeakMap<object, ScreenOcrProcessor>()

export const registerScreenProcessor = (key: object, processor: ScreenOcrProcessor): void => {
  registry.set(key, processor)
}

export const getScreenProcessor = (key: object): ScreenOcrProcessor | undefined => registry.get(key)
