import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, screen, nativeImage, session as electronSession, shell as electronShell, systemPreferences, type MenuItemConstructorOptions } from 'electron'
import type { Fabric } from '@openinfo/contracts'
import { resolveShellConfig, type ShellConfig } from './config.js'
import { hudWindowSpec } from './window-options.js'
import { buildTrayMenu, trayTooltip, type TrayState } from './tray-menu.js'
import { SHORTCUTS, type ShellCommand } from './shortcuts.js'
import { EngineSessionClient, SessionLiveState, needsModelSetup } from './engine-session.js'
import { TRAY_ICON_TEMPLATE_1X, TRAY_ICON_TEMPLATE_2X, trayIconBuffer } from './tray-icon.js'
import { grabOffset, draggedOrigin, resolveStartupPosition, type ScreenPoint } from './window-position.js'
import { readSavedPosition, savePosition } from './window-store.js'
import { EngineLink } from '../engine-link/index.js'
import { CaptureController, type CaptureState } from '../capture/capture-controller.js'
import { CAPTURE_CHANNELS, type CaptureSourceKind, type CaptureStatus, type RawSegment } from '../capture/protocol.js'

/**
 * The Electron shell — the ONLY file that imports electron, and the one tests never import (all the
 * logic it wires lives in the pure sibling modules, asserted headless). It hosts the existing
 * document-driven HUD in a frameless, always-on-top, content-protected window (the inherited Glass
 * signature), a menu-bar tray whose Start/End Session toggles the engine and reflects live state,
 * and the ⌘\ global shortcut that hides/shows the window like Glass.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HUD_HTML = path.join(__dirname, '..', '..', 'hud.html')
const CAPTURE_HTML = path.join(__dirname, '..', '..', 'capture.html')
const PRELOAD_JS = path.join(__dirname, 'preload.cjs') // .cts source → CommonJS preload (see preload.cts)
const CAPTURE_PRELOAD_JS = path.join(__dirname, '..', 'capture', 'capture-preload.cjs') // .cts → CommonJS (see capture-preload.cts)

const cfg: ShellConfig = resolveShellConfig()
const session = new EngineSessionClient(cfg.engineUrl)
const liveState = new SessionLiveState(cfg.workspace)

let hudWindow: BrowserWindow | undefined
let captureWindow: BrowserWindow | undefined
let tray: Tray | undefined
let connected = false
let micState: CaptureState = 'idle'
let systemState: CaptureState = 'idle'
// The far side ("them") is present but delivering pure silence (device found, nothing routed) — the tray
// says so honestly instead of claiming to record it. Flipped by the system controller's onSilence.
let systemSilent = false
// Whether the live fabric's llm slot is empty — drives the tray's prominent "⚠ Set up models…"
// first-run nudge. Undefined until the fabric is fetched, so the tray stays quiet before we know.
let needsSetup: boolean | undefined
// The mic-capture pipeline is built in whenReady (EngineLink needs app.getPath, the controller needs
// the capture window). EngineLink is the capture path (POST /capture/mic + the offline spool); the
// tray keeps its own tiny EngineSessionClient — EngineLink is introduced here only because capture spools.
let engineLink: EngineLink | undefined
let micController: CaptureController | undefined
let systemController: CaptureController | undefined

// Drag state: while a drag is live, `dragTimer` polls the OS cursor and the window rides it, keeping
// `dragOffset` (the grab point within the window) constant. `saveTimer` debounces persisting the origin.
let dragTimer: ReturnType<typeof setInterval> | undefined
let dragOffset: ScreenPoint | undefined
let saveTimer: ReturnType<typeof setTimeout> | undefined

const trayState = (): TrayState => ({
  visible: hudWindow?.isVisible() ?? false,
  sessionLive: liveState.live,
  connected,
  capturing: micState === 'capturing',
  micStarting: micState === 'requesting' || micState === 'starting',
  micBlocked: micState === 'denied',
  systemCapturing: systemState === 'capturing',
  systemSilent,
  needsModelSetup: needsSetup,
})

const refreshTray = (): void => {
  if (!tray) return
  const items: MenuItemConstructorOptions[] = buildTrayMenu(trayState()).map((item) => {
    if (item.type === 'separator') return { type: 'separator' }
    const spec: MenuItemConstructorOptions = { label: item.label ?? '', enabled: item.enabled ?? true }
    if (item.command) {
      const command = item.command
      spec.click = () => dispatch(command)
    }
    return spec
  })
  tray.setContextMenu(Menu.buildFromTemplate(items))
  tray.setToolTip(trayTooltip(trayState()))
}

const showHud = (): void => {
  hudWindow?.showInactive() // never steals focus — a heads-up glance, not a window you work in
  refreshTray()
}
const hideHud = (): void => {
  hudWindow?.hide()
  refreshTray()
}

const dispatch = (command: ShellCommand): void => {
  switch (command) {
    case 'show-hud':
      return showHud()
    case 'hide-hud':
      return hideHud()
    case 'toggle-visibility':
      return hudWindow?.isVisible() ? hideHud() : showHud()
    case 'start-session':
      void session
        .startSession({ workspaceId: cfg.workspace, modeId: cfg.modeId, title: 'menu-bar session' })
        .catch((err) => console.error('[shell] start session failed:', err))
      return
    case 'end-session': {
      const id = liveState.liveSessionId
      if (id) void session.endSession(id).catch((err) => console.error('[shell] end session failed:', err))
      return
    }
    case 'open-setup':
      // The setup surface is served by the ENGINE (GET /setup) — open it in the default browser. It
      // is a forms-over-documents page, roomier than any tray UI, and works even against a remote
      // engine. No embedded webview (that is a later client-settings concern).
      void electronShell.openExternal(`${cfg.engineUrl}/setup`).catch((err) => console.error('[shell] open setup failed:', err))
      return
    case 'quit':
      app.quit()
  }
}

const createHudWindow = (): void => {
  const spec = hudWindowSpec()
  hudWindow = new BrowserWindow({
    ...spec.browserWindow,
    // The one bridge the renderer needs: the drag channel (preload.cts). Nothing node-bound crosses.
    webPreferences: { ...spec.browserWindow.webPreferences, preload: PRELOAD_JS },
  })

  // Method-only hardening (no constructor-option equivalent):
  hudWindow.setContentProtection(spec.hardening.contentProtection)
  hudWindow.setAlwaysOnTop(true, spec.hardening.alwaysOnTopLevel)
  hudWindow.setVisibleOnAllWorkspaces(spec.hardening.visibleOnAllWorkspaces, {
    visibleOnFullScreen: spec.hardening.visibleOnFullScreen,
  })
  console.log(`[shell] HUD window created — content-protection: ${spec.hardening.contentProtection ? 'ON' : 'off'}`)

  restoreHudPosition()
  void hudWindow.loadFile(HUD_HTML, { search: new URLSearchParams({ engine: cfg.engineUrl }).toString() })
  hudWindow.on('moved', scheduleSavePosition) // OS-level moves; the custom drag also persists on drag-end
  hudWindow.on('closed', () => (hudWindow = undefined))
}

/** Open where we last left the HUD — but only if that spot is still on a connected display, else center. */
const restoreHudPosition = (): void => {
  if (!hudWindow) return
  const { width, height } = hudWindow.getBounds()
  const displays = screen.getAllDisplays().map((d) => d.workArea)
  const start = resolveStartupPosition(readSavedPosition(app.getPath('userData')), { width, height }, displays)
  if (start) {
    hudWindow.setPosition(start.x, start.y)
    console.log(`[shell] HUD position restored to ${start.x},${start.y}`)
  } else {
    hudWindow.center()
    console.log('[shell] no usable saved HUD position — centered')
  }
}

/** Persist the current origin, debounced so a drag (many move events) writes once it settles. */
const scheduleSavePosition = (): void => {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = undefined
    if (!hudWindow) return
    const { x, y } = hudWindow.getBounds()
    savePosition(app.getPath('userData'), { x, y })
  }, 400)
}

/** Begin following the cursor: capture the grab offset now, then move the window each tick to keep it. */
const startWindowDrag = (): void => {
  if (!hudWindow || dragTimer) return
  const { x, y } = hudWindow.getBounds()
  dragOffset = grabOffset(screen.getCursorScreenPoint(), { x, y })
  dragTimer = setInterval(() => {
    if (!hudWindow || !dragOffset) return
    const next = draggedOrigin(screen.getCursorScreenPoint(), dragOffset)
    hudWindow.setPosition(next.x, next.y)
  }, 16)
}

/** Stop following the cursor and remember where we ended up. Idempotent (a stray end is a no-op). */
const endWindowDrag = (): void => {
  if (dragTimer) {
    clearInterval(dragTimer)
    dragTimer = undefined
  }
  dragOffset = undefined
  scheduleSavePosition()
}

const createTray = (): void => {
  const icon = nativeImage.createFromBuffer(trayIconBuffer(TRAY_ICON_TEMPLATE_1X))
  icon.addRepresentation({ scaleFactor: 2, buffer: trayIconBuffer(TRAY_ICON_TEMPLATE_2X) })
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  refreshTray()
}

/**
 * The hidden capture window — never shown, no content-protection needed (nothing on screen to hide).
 * It hosts the one place getUserMedia can run (a Chromium renderer); the capture-preload bridge and the
 * compiled renderer (capture-renderer.ts) stream finished audio segments — mic AND system-audio, both in
 * this ONE window — to the main process over IPC. `backgroundThrottling: false` keeps recording steady
 * while the app is a background menu-bar agent.
 */
const createCaptureWindow = (): void => {
  captureWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: CAPTURE_PRELOAD_JS,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  void captureWindow.loadFile(CAPTURE_HTML)
  captureWindow.on('closed', () => (captureWindow = undefined))
  console.log('[shell] hidden capture window created — mic + system-audio renderer host')
}

/**
 * Ask the OS for microphone access before the first capture. On macOS this is the TCC prompt
 * (askForMediaAccess resolves false once denied — the user must re-grant in System Settings, and the
 * controller then keeps capture disabled without crashing; the session/text path is unaffected). The
 * SAME grant covers system-audio too: a BlackHole-like device is an audio INPUT, so it lives under the
 * one Microphone TCC — no separate permission. Non-macOS has no such gate here, so it resolves true and
 * the Chromium permission handler governs.
 */
const requestAudioPermission = async (): Promise<boolean> => {
  if (process.platform !== 'darwin') return true
  try {
    const status = systemPreferences.getMediaAccessStatus('microphone')
    console.log(`[shell] mic access status before request: ${status}`)
    return await systemPreferences.askForMediaAccess('microphone')
  } catch (err) {
    console.error('[shell] audio permission request failed:', err)
    return false
  }
}

// The mic + system-audio controllers both start on the same session-start and share ONE Microphone TCC
// grant, so their permission requests are deduped to a single in-flight prompt: the first caller triggers
// the real ask, the second awaits the same promise. Reset once resolved, so a LATER session re-checks
// (permission may have been granted/revoked in System Settings between sessions).
let permissionInFlight: Promise<boolean> | undefined
const sharedAudioPermission = (): Promise<boolean> => {
  if (!permissionInFlight) {
    permissionInFlight = requestAudioPermission().finally(() => {
      permissionInFlight = undefined
    })
  }
  return permissionInFlight
}

/** Route a per-source IPC message (segment/stopped/status) to the controller that owns that source. */
const controllerFor = (source: CaptureSourceKind): CaptureController | undefined =>
  source === 'mic' ? micController : systemController

/**
 * Build the capture controllers (one per source — mic "me" + system-audio "them") and wire the shared
 * renderer IPC. Both drive the ONE hidden window over source-tagged channels; the session lifecycle
 * drives both. The mic path is unchanged from the mic-only slice; system-audio rhymes with it and only
 * activates when a BlackHole-like device is present (else it reports no-device and stays a silent no-op).
 */
const setupCapture = (): void => {
  engineLink = new EngineLink({ baseUrl: cfg.engineUrl, spoolDir: path.join(app.getPath('userData'), 'capture-spool') })
  engineLink.startFlushLoop() // drain spooled chunks once the engine is reachable again (offline-safe)
  const link = engineLink
  micController = new CaptureController({
    source: 'mic',
    enabled: cfg.micEnabled,
    capture: (chunk) => link.capture(chunk),
    control: {
      start: () => captureWindow?.webContents.send(CAPTURE_CHANNELS.start, 'mic'),
      stop: () => captureWindow?.webContents.send(CAPTURE_CHANNELS.stop, 'mic'),
    },
    requestPermission: sharedAudioPermission,
    onStateChange: (state) => {
      micState = state
      refreshTray()
    },
    log: (message) => console.log(message),
  })
  systemController = new CaptureController({
    source: 'system-audio',
    enabled: cfg.systemAudioEnabled,
    capture: (chunk) => link.capture(chunk),
    control: {
      start: () => captureWindow?.webContents.send(CAPTURE_CHANNELS.start, 'system-audio'),
      stop: () => captureWindow?.webContents.send(CAPTURE_CHANNELS.stop, 'system-audio'),
    },
    requestPermission: sharedAudioPermission,
    onStateChange: (state) => {
      systemState = state
      if (state !== 'capturing') systemSilent = false // no live capture ⇒ no silence claim either way
      refreshTray()
    },
    onSilence: (silent) => {
      systemSilent = silent
      refreshTray()
    },
    log: (message) => console.log(message),
  })
  ipcMain.on(CAPTURE_CHANNELS.segment, (_event, segment: RawSegment) => void controllerFor(segment.source)?.onSegment(segment))
  ipcMain.on(CAPTURE_CHANNELS.stopped, (_event, source: CaptureSourceKind) => void controllerFor(source)?.onCaptureStopped())
  ipcMain.on(CAPTURE_CHANNELS.status, (_event, status: CaptureStatus) => controllerFor(status.source)?.onStatus(status))
  console.log(`[shell] mic capture ${cfg.micEnabled ? 'enabled' : 'disabled by config'} · system-audio ${cfg.systemAudioEnabled ? 'enabled' : 'disabled by config'} (both follow the session lifecycle)`)
}

/**
 * Mirror the session's live state into BOTH capture sources: a live session starts mic + system-audio
 * (its ids tag the chunks), ending it stops + flushes each final segment. This is the whole "the tray
 * toggle is the capture switch, zero new UI" wiring — capture strictly follows the session the tray
 * already controls. System-audio self-resolves to a no-op if no BlackHole-like device is present.
 */
const applyCaptureLifecycle = (live: boolean): void => {
  if (live) {
    const sessionId = liveState.liveSessionId
    if (sessionId) {
      const context = { sessionId, workspaceId: cfg.workspace }
      void micController?.onSessionStarted(context)
      void systemController?.onSessionStarted(context)
    }
  } else {
    micController?.onSessionEnded()
    systemController?.onSessionEnded()
  }
}

/** Push live-session state from the engine WS (session.started/ended) — no polling; see engine-session.ts. */
const connectEvents = (): void => {
  const wsUrl = `${cfg.engineUrl.replace(/^http/, 'ws')}/events`
  const socket = new WebSocket(wsUrl)
  socket.addEventListener('message', (event) => {
    try {
      const parsed = JSON.parse(String((event as { data: unknown }).data)) as { name?: unknown; payload?: unknown }
      if (typeof parsed.name !== 'string') return
      if (liveState.applyEvent({ name: parsed.name, payload: parsed.payload })) refreshTray()
      // The live fabric changed (activate / PUT /fabric / active-profile edit) — recompute whether
      // the "Set up models…" nudge should be prominent, without a refetch (the event carries the map).
      if (parsed.name === 'fabric.changed' && parsed.payload) {
        needsSetup = needsModelSetup(parsed.payload as Fabric)
        refreshTray()
      }
    } catch {
      /* ignore malformed frames */
    }
  })
  socket.addEventListener('close', () => setTimeout(connectEvents, 1500)) // reconnect + re-seed below
  socket.addEventListener('open', () => void seedSessionState())
}

const seedSessionState = async (): Promise<void> => {
  try {
    liveState.seed(await session.liveSession(cfg.workspace))
    connected = true
  } catch (err) {
    console.error('[shell] could not reach engine for session state:', err)
    connected = false
  }
  // Seed the "Set up models…" prominence from the live fabric (best-effort — a failure just leaves
  // the nudge quiet rather than crashing the tray).
  try {
    needsSetup = needsModelSetup(await session.fabric())
  } catch (err) {
    console.error('[shell] could not read fabric for setup nudge:', err)
  }
  refreshTray()
}

app.whenReady().then(() => {
  app.dock?.hide() // menu-bar-only agent (no dock icon), like a Glass-style companion
  // Grant only the media (mic) permission at the Chromium layer for our own windows; deny everything
  // else. The OS-level (TCC) gate is separate — requestMicPermission handles that before capture.
  electronSession.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'media'))
  liveState.onChange((live) => {
    refreshTray()
    applyCaptureLifecycle(live)
  })
  ipcMain.on('hud:drag-start', () => startWindowDrag())
  ipcMain.on('hud:drag-end', () => endWindowDrag())
  createHudWindow()
  createCaptureWindow()
  createTray()
  setupCapture()
  void seedSessionState()
  connectEvents()
  for (const { accelerator, command } of SHORTCUTS) {
    const ok = globalShortcut.register(accelerator, () => dispatch(command))
    console.log(`[shell] shortcut ${accelerator} → ${command}: ${ok ? 'registered' : 'FAILED (in use?)'}`)
  }
})

app.on('window-all-closed', () => {
  /* keep the app alive as a menu-bar agent even with the HUD hidden/closed */
})
app.on('before-quit', () => {
  micController?.shutdown() // stop both streams cleanly if quitting mid-capture
  systemController?.shutdown()
})
app.on('will-quit', () => globalShortcut.unregisterAll())
