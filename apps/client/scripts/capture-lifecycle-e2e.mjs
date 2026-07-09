/**
 * Driven REAL-Electron e2e for the capture consent + readiness handshake + un-wedge fix (issue #41).
 *
 * Green unit tests are not proof that the SERVED capture path behaves — the whole failure class lived in
 * the electron edges (a fire-and-forget `webContents.send` racing the hidden renderer's ESM load, a
 * leftover session auto-capturing on boot). So this launches REAL Electron with the REAL compiled
 * capture-preload + REAL capture-renderer against the REAL CaptureDispatcher / CaptureController /
 * CaptureConsent, and drives the two behaviours that route tests cannot see:
 *
 *   PHASE 1 (healthy renderer, real getUserMedia via Chromium's fake media device):
 *     • the renderer pings `capture:loaded` on module load           → readiness handshake exists
 *     • a live session with consent NOT granted starts NOTHING        → the boot guard holds
 *     • after the user consents, `capture:start` is delivered, the renderer ACKS it, and capture
 *       genuinely begins (`status: ready`, only sent after getUserMedia resolves) → no silent drop
 *
 *   PHASE 2 (sabotaged renderer that loads but never registers onStart — the ORIGINAL bug):
 *     • the start send is dropped, no ack comes back, and the dispatcher RETRIES then surfaces a
 *       VISIBLE fault instead of sitting in `starting` forever → the wedge is impossible
 *
 * It is a "probe main" (the hud-bounds-e2e precedent): it mirrors shell.ts's capture wiring — the
 * dispatcher gated by consent, the controller fed the session lifecycle — with no tray/engine, so the
 * test is about the capture handshake and nothing else.
 *
 * Run: pnpm --filter @openinfo/client test:e2e:capture  (builds first). Needs a GUI (darwin) — not wired
 * into the headless default `test`.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain, session as electronSession } from 'electron'
import { CaptureController } from '../dist/capture/capture-controller.js'
import { CAPTURE_CHANNELS } from '../dist/capture/protocol.js'
import { CaptureDispatcher } from '../dist/main/capture-dispatcher.js'
import { CaptureConsent } from '../dist/main/capture-consent.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_DIR = path.join(__dirname, '..')
const CAPTURE_HTML = path.join(CLIENT_DIR, 'capture.html') // the REAL hidden-capture document
const SABOTAGE_HTML = path.join(__dirname, 'e2e-capture-sabotage.html')
const CAPTURE_PRELOAD_JS = path.join(CLIENT_DIR, 'dist', 'capture', 'capture-preload.cjs')

// Chromium's fake media device: real getUserMedia + real MediaRecorder resolve with a synthetic stream,
// no OS mic and no permission prompt — so the REAL renderer runs unchanged in a headless-ish GUI run.
app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
app.commandLine.appendSwitch('use-fake-device-for-media-stream')

const fail = (msg) => {
  console.error(`\n[e2e] FAIL: ${msg}`)
  app.exit(1)
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

// --- the current phase's wiring, reached by the shared ipcMain handlers -------------------------------
let current // { win, dispatcher, controller, consent, sent, acks, statuses, faults, loaded, applyLifecycle }

const makeWiring = (win, dispatcherOpts = {}) => {
  const sent = []
  const acks = []
  const statuses = []
  const faults = []
  const flags = { loaded: false }
  const consent = new CaptureConsent()
  const dispatcher = new CaptureDispatcher({
    send: (channel, source) => {
      sent.push({ channel, source })
      win.webContents.send(channel === 'start' ? CAPTURE_CHANNELS.start : CAPTURE_CHANNELS.stop, source)
    },
    onFault: (source, reason) => faults.push({ source, reason }),
    log: (m) => console.log(`[e2e] ${m}`),
    ...dispatcherOpts,
  })
  const controller = new CaptureController({
    source: 'mic',
    enabled: true,
    capture: async () => {},
    control: { start: () => dispatcher.requestStart('mic'), stop: () => dispatcher.requestStop('mic') },
    requestPermission: async () => true,
    log: (m) => console.log(`[e2e] ${m}`),
  })
  // Mirror shell.ts applyCaptureLifecycle's BOOT GUARD: a live transition drives capture only with consent.
  const applyLifecycle = (live) => {
    if (live) {
      if (!consent.canAutoStart) {
        console.log('[e2e] live session but no consent this launch — NOT starting capture (boot guard)')
        return
      }
      void controller.onSessionStarted({ sessionId: 'ses-e2e', workspaceId: 'default' })
    } else {
      controller.onSessionEnded()
    }
  }
  return { win, dispatcher, controller, consent, sent, acks, statuses, faults, flags, applyLifecycle }
}

// Shared IPC — route each renderer message to the CURRENT phase's wiring (like shell.ts's handlers).
ipcMain.on(CAPTURE_CHANNELS.loaded, () => {
  if (!current) return
  current.flags.loaded = true
  current.dispatcher.markLoaded()
})
ipcMain.on(CAPTURE_CHANNELS.startAck, (_e, source) => {
  if (!current) return
  current.acks.push(source)
  current.dispatcher.ackStart(source)
})
ipcMain.on(CAPTURE_CHANNELS.status, (_e, status) => {
  if (!current) return
  current.statuses.push(status)
  current.controller.onStatus(status)
})
ipcMain.on(CAPTURE_CHANNELS.stopped, (_e, source) => void current?.controller.onCaptureStopped())
ipcMain.on(CAPTURE_CHANNELS.segment, (_e, segment) => void current?.controller.onSegment(segment))

const newCaptureWindow = (htmlPath) => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: CAPTURE_PRELOAD_JS, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  })
  win.webContents.on('console-message', (d) => {
    if (d.level === 'error') console.error(`[capture] ${d.message}`)
  })
  win.loadFile(htmlPath)
  return win
}

/** Poll until `predicate()` is truthy or `ms` elapses. */
const waitFor = async (predicate, ms, label) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(50)
  }
  throw new Error(`timed out waiting for: ${label}`)
}

const phaseHealthy = async () => {
  const win = newCaptureWindow(CAPTURE_HTML)
  current = makeWiring(win) // default dispatcher timings
  await waitFor(() => current.flags.loaded, 8000, 'the renderer to ping capture:loaded (readiness handshake)')
  console.log('[e2e] PHASE 1 — renderer loaded ping received')

  // Boot guard: a leftover live session at boot, consent NOT granted → nothing must start.
  current.applyLifecycle(true)
  await delay(600)
  if (current.sent.some((s) => s.channel === 'start')) return fail('boot guard breached — capture started without consent')
  if (current.controller.currentState !== 'idle') return fail(`boot guard breached — controller is ${current.controller.currentState}, expected idle`)
  console.log('[e2e] PHASE 1 — boot guard held: no capture without consent')

  // Now the user consents and a session goes live → start must be delivered, acked, and capture begins.
  current.consent.grant()
  current.applyLifecycle(true)
  await waitFor(() => current.sent.some((s) => s.channel === 'start' && s.source === 'mic'), 4000, 'a capture:start to be delivered')
  await waitFor(() => current.acks.includes('mic'), 4000, 'the renderer to ACK the start')
  await waitFor(() => current.statuses.some((s) => s.state === 'ready'), 8000, 'capture to begin (status: ready after getUserMedia)')
  if (current.faults.length > 0) return fail(`unexpected fault on the healthy path: ${JSON.stringify(current.faults)}`)
  console.log('[e2e] PHASE 1 — start delivered + acked + capture began (status: ready) — no silent drop')

  // Clean stop so the window's recorder tears down before the next phase.
  current.applyLifecycle(false)
  await delay(300)
  win.destroy()
}

const phaseSabotage = async () => {
  const win = newCaptureWindow(SABOTAGE_HTML)
  // Tight timings so the fault surfaces quickly: ~2 attempts × 300ms.
  current = makeWiring(win, { ackTimeoutMs: 300, maxRetries: 2 })
  await waitFor(() => current.flags.loaded, 8000, 'the sabotaged renderer to ping capture:loaded')
  console.log('[e2e] PHASE 2 — sabotaged renderer loaded (but registers no start listener)')

  current.consent.grant()
  current.applyLifecycle(true)
  // The renderer never acks (no onStart handler) → retries → a VISIBLE fault, never a silent wedge.
  await waitFor(() => current.faults.length > 0, 5000, 'the dispatcher to surface a visible fault for the dropped start')
  if (!current.acks.includes('mic')) console.log('[e2e] PHASE 2 — confirmed no start-ack was ever received (send dropped)')
  else return fail('sabotaged renderer unexpectedly acked — the sabotage is not exercising the drop')
  console.log(`[e2e] PHASE 2 — visible fault surfaced: ${current.faults[0].reason}`)
  win.destroy()
}

// Destroying a phase's window briefly leaves zero windows — keep the app alive across phases.
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  electronSession.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'))
  try {
    await phaseHealthy()
    await phaseSabotage()
    console.log('\n[e2e] PASS — boot guard holds, the readiness/ack handshake completes, and a dropped start faults visibly')
    app.exit(0)
  } catch (err) {
    fail(String(err?.stack ?? err))
  }
})

setTimeout(() => fail('timed out after 45s'), 45_000)
