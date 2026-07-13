import { createEngineApp } from './api/http.js'
import { resolveControlPlane, type ControlPlane, type ResolveControlPlaneOptions } from './api/control-plane.js'
import { startCalendarCollector } from './route/index.js'
import { wireScreenOcr } from './screen/index.js'
import { wireTeach } from './teach/index.js'

const isEntry = process.argv[1]?.endsWith('/main.js') ?? false

export interface RunningEngine {
  app: ReturnType<typeof createEngineApp>
  controlPlane: ControlPlane
  close(): Promise<void>
}

export interface StartEngineOptions extends ResolveControlPlaneOptions {
  /** Test/embedder seam; production leaves this unset and uses OPENINFO_DATA/defaultDataDir. */
  dataRoot?: string
  log?: (message: string) => void
}

/**
 * Product startup is secure-by-construction: resolve the authenticated control-plane policy BEFORE the
 * store, collectors, or listener are created. An invalid/non-loopback configuration therefore fails with
 * no daemon and no misleading discovery record. The lower-level createEngineApp remains importable from
 * api/http for in-process route tests, but is no longer re-exported as the product constructor here.
 */
export const startEngine = async (options: StartEngineOptions = {}): Promise<RunningEngine> => {
  const log = options.log ?? console.log
  const controlPlane = resolveControlPlane(options)
  const app = createEngineApp({
    controlPlane,
    ...(options.dataRoot !== undefined ? { dataRoot: options.dataRoot } : {}),
    log,
  })
  // Screen understanding (P4B): the screen-OCR processor rides capture ingest, gated on `screen.ocr`.
  // Wired here (not inside createEngineApp) so it stays out of the P4A-owned http.ts; tests wire the
  // same way explicitly. The /screen router is mounted inside http.ts and reads this processor's status.
  wireScreenOcr(app, { log: console.log })
  // Calendar routing signal (P4C): the engine-side collector polls Calendar.app while route.detect is ON
  // and feeds the same detector as focus. Mounted here (like wireScreenOcr) so the OS-facing timer stays
  // out of createEngineApp (which the http tests construct); it degrades to nothing without calendar access.
  const calendar = startCalendarCollector(app, { log })
  // Teach loop (P4D): capture every `session.rerouted` correction as a per-workspace TeachSignal. Wired
  // here (not in http.ts) mirroring wireScreenOcr — a bus subscription, no route, the derivation is a
  // pure read a future teach surface calls on demand (SUGGESTS hint patterns; never auto-applies to route/).
  wireTeach(app, { log })

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error)
      app.server.once('error', onError)
      app.server.listen(controlPlane.port, controlPlane.bindHost, () => {
        app.server.off('error', onError)
        resolve()
      })
    })
    // Publish only after the port is live. A failed/invalid startup never leaves a credential claiming
    // that an engine exists; a prior stale per-port record is atomically replaced here.
    await controlPlane.publishDiscovery()
  } catch (error) {
    calendar.stop()
    await app.close().catch(() => undefined)
    throw error
  }

  log(
    controlPlane.mode === 'local'
      ? `openinfo engine on ${controlPlane.baseUrl} (authenticated loopback control plane)`
      : `openinfo engine on ${controlPlane.baseUrl} behind trusted tunnel ${controlPlane.publicOrigin ?? '(invalid)'}`,
  )

  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    closing ??= (async () => {
      // Remove discovery while this process still owns the bound port. cleanupDiscovery also checks the
      // instance id, so it cannot erase a later launch's atomically replaced record.
      await controlPlane.cleanupDiscovery()
      calendar.stop()
      await app.close()
    })()
    return closing
  }
  return { app, controlPlane, close }
}

if (isEntry) {
  void startEngine().then((running) => {
    let stopping = false
    const stop = (signal: NodeJS.Signals): void => {
      if (stopping) return
      stopping = true
      console.log(`openinfo engine received ${signal}; shutting down`)
      void running.close().catch((error: unknown) => {
        console.error(`openinfo engine shutdown failed: ${error instanceof Error ? error.message : String(error)}`)
        process.exitCode = 1
      })
    }
    process.once('SIGINT', () => stop('SIGINT'))
    process.once('SIGTERM', () => stop('SIGTERM'))
  }).catch((error: unknown) => {
    console.error(`openinfo engine refused startup: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
