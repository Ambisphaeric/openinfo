import type { EngineEvents } from '../bus/index.js'
import type { EventBus } from '../bus/index.js'
import type { WorkspaceRegistry } from '../store/index.js'
import { TeachStore, captureReroute } from './signals.js'

export { TeachStore, captureReroute, captureEntityCorrection, deriveHintCandidates, type HintCandidate } from './signals.js'

/** The engine surface wireTeach needs — EngineApp is structurally compatible ({ bus, store, … }). */
export interface TeachWiringApp {
  bus: EventBus<EngineEvents>
  store: WorkspaceRegistry
}

export interface TeachWiringOptions {
  log?: (message: string) => void
}

/**
 * Wire the teach loop onto a running engine (main.ts calls this after createEngineApp; tests wire the same
 * way explicitly — the wireScreenOcr pattern, keeping bus wiring out of the P4A-owned api/http.ts). It
 * subscribes to `session.rerouted` — the correction signal route/reroute.ts ALREADY emits — and records
 * each reroute as a per-workspace TeachSignal via the store-backed TeachStore. That is the whole capture
 * side of the loop: every user correction becomes a labeled, stored, derivable signal.
 *
 * The derivation (deriveHintCandidates) is a PURE read over the stored signals, called on demand by a
 * future teach surface; it is deliberately NOT run here and NEVER auto-applies to route/hints — the loop
 * SUGGESTS, the user APPLIES. Recording is a synchronous sqlite document write on an infrequent event
 * (a human clicking reroute), so the subscription does no async work. Returns the TeachStore (mirrors
 * wireScreenOcr returning its processor) for a caller/test that wants to read the accumulated signals.
 */
export const wireTeach = (app: TeachWiringApp, options: TeachWiringOptions = {}): TeachStore => {
  const log = options.log ?? (() => undefined)
  const teach = new TeachStore(app.store)
  app.bus.subscribe('session.rerouted', (session) => {
    const signal = captureReroute(session)
    if (!signal) return
    teach.record(signal)
    log(`teach: recorded reroute signal for workspace ${signal.toWorkspaceId} (session ${signal.sessionId}, from ${signal.fromWorkspaceId})`)
  })
  return teach
}
