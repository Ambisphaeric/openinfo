import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, screen, nativeImage, session as electronSession, shell as electronShell, systemPreferences, desktopCapturer, utilityProcess, type UtilityProcess, type MenuItemConstructorOptions } from 'electron'
import type { Fabric, Flag } from '@openinfo/contracts'
import { resolveShellConfig, loadClientConfigFile, type ShellConfig } from './config.js'
import { decideEngineDisposition, checkEngineReachable, waitForEngine, bundledEngineEntry, portFromEngineUrl, fetchEngineHealth, engineStatusLine, type EngineDisposition, type EngineHealth } from './engine-supervisor.js'
import { hudWindowSpec, HUD_MIN_HEIGHT } from './window-options.js'
import { resolveHudHeight } from './hud-height.js'
import { buildTrayMenu, trayTooltip, type TrayState, type TrayMenuItem } from './tray-menu.js'
import { SHORTCUTS, type ShellCommand } from './shortcuts.js'
import { settingsUrlFor, isLanEngine } from './permission-help.js'
import { ContextHealthTracker } from './context-health.js'
import { shouldOpenSetup, shouldPromptMic } from './first-run.js'
import { readFirstRunState, markFirstRunShown, markMicPrompted } from './first-run-store.js'
import { captureStatuses, type MediaAccessStatus, type SysAudioPresence } from './capture-status.js'
import { EngineSessionClient, SessionLiveState, needsModelSetup } from './engine-session.js'
import { TRAY_ICON_TEMPLATE_1X, TRAY_ICON_TEMPLATE_2X, trayIconBuffer } from './tray-icon.js'
import { grabOffset, draggedOrigin, resolveStartupPosition, type ScreenPoint } from './window-position.js'
import { readSavedPosition, savePosition } from './window-store.js'
import { EngineLink } from '../engine-link/index.js'
import { CaptureController, type CaptureState } from '../capture/capture-controller.js'
import { CAPTURE_CHANNELS, type CaptureSourceKind, type CaptureStatus, type RawSegment } from '../capture/protocol.js'
import { CaptureConsent } from './capture-consent.js'
import { CaptureDispatcher, type DispatchChannel } from './capture-dispatcher.js'
import { createClientLog, type ClientLog } from './client-log.js'
import { FocusPoller, detectEnabledFrom, ROUTE_DETECT_FLAG } from '../capture/focus-poller.js'
import type { FrontmostWindow } from '../capture/focus.js'

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

// env > ~/.openinfo/client.json > defaults — the file lets a double-clicked packaged .app point at an
// engine without env vars (env still wins, so the verifier can override on the command line). See config.ts.
const cfg: ShellConfig = resolveShellConfig(process.env, loadClientConfigFile())
const session = new EngineSessionClient(cfg.engineUrl)
const liveState = new SessionLiveState(cfg.workspace)
// The boot guard (issue #41): capture only ever auto-starts on a live-session transition the USER
// initiated this launch (Start Session), never on a leftover session seeded at boot. See capture-consent.ts.
const captureConsent = new CaptureConsent()
// The rotating client log file — the packaged app has no terminal, so capture lifecycle + failures went
// to a lost stdout (issue #41). Assigned a real file logger in whenReady (needs app.getPath); until then
// a console fallback so any early line is not lost. See client-log.ts.
let clientLog: ClientLog = (message: string) => console.log(message)
// True once the engine's LAN class is known — drives the honest "check Local Network permission?" hint
// when a non-loopback engine is unreachable (a possibility, never a detection). See permission-help.ts.
const lanEngine = isLanEngine(cfg.engineUrl)
// Tracks whether context detection is actually yielding window titles — drives the "Grant Accessibility…"
// fix-it. Fed each focus sample in setupFocus. See context-health.ts.
const contextHealth = new ContextHealthTracker()

let hudWindow: BrowserWindow | undefined
let captureWindow: BrowserWindow | undefined
let tray: Tray | undefined
// The engine child WE spawned (only when the configured URL answered nothing AND we shipped a bundled
// engine). Undefined when we adopted an already-running engine — so we NEVER kill an engine we didn't
// start; only this child is shut down, on quit. See engine-supervisor.ts + ensureEngine.
let spawnedEngine: UtilityProcess | undefined
// The engine version handshake captured at startup: which engine we ended up on (adopt/spawn/unreachable)
// and its reported version/build. Feeds the tray's "engine v0.0.1 · adopted at :8787" info line + skew
// note. Undefined until ensureEngine resolves. See engine-supervisor.ts (pure, tested headless).
let engineDisposition: EngineDisposition | undefined
let engineHealth: EngineHealth = {}
let connected = false
// Has the shell attempted the engine yet? Distinguishes first-boot "connecting…" from a genuine
// "engine unreachable" leading state (set true once the first seed attempt resolves, success or fail).
let engineTried = false
// First-run /setup auto-open is evaluated at most once we've reached the engine (guarded so the two
// seed calls — whenReady + WS open — never double-open, and a persisted firstRunShownAt never re-opens).
let firstRunChecked = false
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
// The renderer readiness + start-ack handshake for the two audio sources (issue #41). Gates every
// control.start on the hidden renderer having loaded + acked, retrying/queueing instead of the old
// fire-and-forget send that raced boot and was silently dropped. Screen never rides it (main-process).
let captureDispatcher: CaptureDispatcher | undefined
// A VISIBLE capture failure (dropped start / renderer gone) surfaced on the tray — see tray-menu.ts.
let captureFault: string | undefined
// True between a capture-renderer crash and its reload — so the reload re-arms capture for a live session.
let captureRendererCrashed = false
// The screen-capture controller ("what's on screen") + its cadence timer. Screen is captured in the MAIN
// process (desktopCapturer, below) rather than the hidden audio renderer, but rides the same controller +
// session lifecycle + EngineLink spool. Opt-IN (cfg.screenEnabled default OFF) — see config.ts.
let screenController: CaptureController | undefined
let screenTimer: ReturnType<typeof setInterval> | undefined
// The focus (foreground-window context) poller — main-process, session-INDEPENDENT, gated on the
// engine's route.detect flag + the local OPENINFO_FOCUS opt-out. `focusActive` mirrors whether it is
// currently watching, for the tray's quiet "· watching context" tooltip.
let focusPoller: FocusPoller | undefined
let focusActive = false

// Drag state: while a drag is live, `dragTimer` polls the OS cursor and the window rides it, keeping
// `dragOffset` (the grab point within the window) constant. `saveTimer` debounces persisting the origin.
let dragTimer: ReturnType<typeof setInterval> | undefined
let dragOffset: ScreenPoint | undefined
let saveTimer: ReturnType<typeof setTimeout> | undefined

// The capture-status readout's raw inputs, read live at each tray paint so the readout reflects the
// current OS state (a user can flip a Settings toggle and see it update on the next open). macOS-only
// TCC statuses; off macOS getMediaAccessStatus is not the gate, so we report 'unknown' (unsupported).
const mediaStatus = (media: 'microphone' | 'screen'): MediaAccessStatus | undefined => {
  if (process.platform !== 'darwin') return undefined
  try {
    return systemPreferences.getMediaAccessStatus(media) as MediaAccessStatus
  } catch (err) {
    console.error(`[shell] getMediaAccessStatus(${media}) failed:`, err)
    return 'unknown'
  }
}
// System-audio is device presence, not a TCC gate: the capture controller reports 'unavailable' when no
// BlackHole-class loopback input exists, 'capturing'/'starting' once one is streaming; otherwise unknown
// (presence is only learned once capture is attempted).
const sysAudioPresence = (): SysAudioPresence =>
  systemState === 'unavailable' ? 'missing-device' : systemState === 'capturing' || systemState === 'starting' ? 'present' : 'unknown'

/** Assemble the capture-status inputs, omitting the macOS-only fields entirely when they're unavailable. */
const captureStatusInput = () => {
  const mic = mediaStatus('microphone')
  const screenAccess = mediaStatus('screen')
  return {
    platform: process.platform,
    ...(mic !== undefined ? { micAccess: mic } : {}),
    ...(screenAccess !== undefined ? { screenAccess } : {}),
    sysAudio: sysAudioPresence(),
    screenEnabled: cfg.screenEnabled,
  }
}

const trayState = (): TrayState => ({
  visible: hudWindow?.isVisible() ?? false,
  sessionLive: liveState.live,
  connected,
  engineTried,
  engineUrl: cfg.engineUrl,
  lanEngine,
  capturing: micState === 'capturing',
  micStarting: micState === 'requesting' || micState === 'starting',
  micBlocked: micState === 'denied',
  captureFault,
  systemCapturing: systemState === 'capturing',
  systemSilent,
  needsModelSetup: needsSetup,
  watchingContext: focusActive,
  accessibilityHint: contextHealth.needsAccessibility,
  engineInfoLine: engineDisposition
    ? engineStatusLine({
        disposition: engineDisposition,
        engineUrl: cfg.engineUrl,
        appVersion: app.getVersion(),
        ...(engineHealth.version !== undefined ? { engineVersion: engineHealth.version } : {}),
        ...(engineHealth.build !== undefined ? { build: engineHealth.build } : {}),
      })
    : undefined,
  captureStatus: captureStatuses(captureStatusInput()),
})

const toMenuItem = (item: TrayMenuItem): MenuItemConstructorOptions => {
  if (item.type === 'separator') return { type: 'separator' }
  const spec: MenuItemConstructorOptions = { label: item.label ?? '', enabled: item.enabled ?? true }
  if (item.command) {
    const command = item.command
    spec.click = () => dispatch(command)
  }
  if (item.submenu) spec.submenu = item.submenu.map(toMenuItem) // recursive — the Capture-status readout
  return spec
}

const refreshTray = (): void => {
  if (!tray) return
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenu(trayState()).map(toMenuItem)))
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
      // The explicit consent gesture (issue #41): the user is turning capture ON this launch, so a
      // live-session transition may now drive capture. A stale prior fault is cleared as we retry.
      captureConsent.grant()
      captureFault = undefined
      clientLog('[shell] user started a session — capture consent granted for this launch')
      void session
        .startSession({ workspaceId: cfg.workspace, modeId: cfg.modeId, title: 'menu-bar session' })
        .catch((err) => clientLog(`[shell] start session failed: ${String(err)}`))
      return
    case 'end-session': {
      // The user is turning capture OFF — revoke consent so nothing auto-resumes it (and a leftover
      // session, if any, will not silently re-capture).
      captureConsent.revoke()
      const id = liveState.liveSessionId
      if (id) void session.endSession(id).catch((err) => clientLog(`[shell] end session failed: ${String(err)}`))
      return
    }
    case 'open-setup':
      // The settings surface is served by the ENGINE (GET /settings — formerly /setup, which 301s
      // here) — open it in the default browser. It is a sidebar of forms-over-documents sections,
      // roomier than any tray UI, and works even against a remote engine. No embedded webview (that is
      // a later client-settings concern).
      void electronShell.openExternal(`${cfg.engineUrl}/settings`).catch((err) => console.error('[shell] open settings failed:', err))
      return
    case 'open-mic-settings':
    case 'open-accessibility-settings':
    case 'open-screen-settings':
      // Denial must be actionable: an unsigned dev app can't re-fire a denied TCC prompt (and screen
      // recording never had an in-app prompt), so open the exact System Settings pane and let the user
      // grant it there. See permission-help.ts.
      void electronShell.openExternal(settingsUrlFor(command)).catch((err) => console.error(`[shell] open settings (${command}) failed:`, err))
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

  // Renderer observability: this window is TRANSPARENT, so a dead/blank renderer is otherwise
  // indistinguishable from "hidden". Surface load failures, renderer death, and error-level console
  // lines on the main-process stdout (visible when the .app is launched from a terminal).
  hudWindow.webContents.on('did-fail-load', (_event, code, description) =>
    console.error(`[shell] HUD page failed to load: ${code} ${description}`))
  hudWindow.webContents.on('render-process-gone', (_event, details) =>
    console.error(`[shell] HUD renderer gone: ${details.reason} (exitCode ${details.exitCode})`))
  hudWindow.webContents.on('console-message', (details) => {
    if (details.level === 'error') console.error(`[hud] ${details.message} (${details.sourceId}:${details.lineNumber})`)
  })

  restoreHudPosition()
  // Pass BOTH the engine URL and the configured surface id (ShellConfig.surfaceId, resolved env >
  // client.json > default surf-openinfo-hud) so the HUD renders the chosen layout — the minimal honest
  // switch for "point a HUD at a different surface" (PHASE3-NOTES). `outline=1` (ShellConfig.hudOutline,
  // OPENINFO_HUD_OUTLINE / client.json hudOutline) draws the debug bounds — see surfaces/hud/styles.ts.
  void hudWindow.loadFile(HUD_HTML, {
    search: new URLSearchParams({
      engine: cfg.engineUrl,
      surface: cfg.surfaceId,
      ...(cfg.hudOutline ? { outline: '1' } : {}),
    }).toString(),
  })
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

/**
 * Content-size the frameless HUD to the panel the renderer just measured (hud:resize, from
 * auto-resize.ts). The transparent window is otherwise a fixed frame whose empty lower portion blocks
 * clicks; sizing it to content removes that dead zone. `measured` is CONTENT height, so setContentSize
 * (not setSize). Top-left origin is left untouched, so the window grows/shrinks downward — drag/position
 * persistence is unaffected. Capped at the display work-area so a runaway panel never grows off-screen,
 * floored at HUD_MIN_HEIGHT (the empty-state bar). Unchanged heights are skipped to avoid churn.
 */
const resizeHudToContent = (measured: number): void => {
  if (!hudWindow) return
  const max = screen.getDisplayMatching(hudWindow.getBounds()).workArea.height
  const height = resolveHudHeight(measured, { min: HUD_MIN_HEIGHT, max })
  const [w = 0, currentHeight = 0] = hudWindow.getContentSize()
  if (height === currentHeight) return
  hudWindow.setContentSize(w, height)
  if (cfg.hudOutline) {
    const b = hudWindow.getBounds()
    console.log(`[shell] hud:resize measured=${measured} → content ${w}×${height} · bounds ${b.width}×${b.height} @ ${b.x},${b.y}`)
  }
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
  // Renderer observability (issue #41): this window is hidden, so a dead/never-loaded renderer used to
  // be invisible — the exact silent-drop failure class. Surface load failure + renderer death, mark the
  // dispatcher unloaded so no start is sent into the void, and recover by reloading the host.
  captureWindow.webContents.on('did-fail-load', (_event, code, description) =>
    onCaptureRendererLost(`page failed to load: ${code} ${description}`))
  captureWindow.webContents.on('render-process-gone', (_event, details) =>
    onCaptureRendererLost(`renderer gone: ${details.reason} (exitCode ${details.exitCode})`))
  void captureWindow.loadFile(CAPTURE_HTML)
  captureWindow.on('closed', () => (captureWindow = undefined))
  console.log('[shell] hidden capture window created — mic + system-audio renderer host')
}

/**
 * The capture renderer died or failed to load. Surface it VISIBLY (tray + log), stop pretending the
 * audio controllers are warming up, tell the dispatcher the renderer is gone (so starts re-queue rather
 * than drop), and reload the host. On the reload's `capture:loaded` ping we re-arm capture if a session
 * is live and the user consented — so a renderer crash mid-session self-heals instead of wedging.
 */
const onCaptureRendererLost = (reason: string): void => {
  clientLog(`[shell] capture renderer lost — ${reason}`)
  captureRendererCrashed = true
  captureDispatcher?.markUnloaded(reason)
  micController?.onStartFailed(reason)
  systemController?.onStartFailed(reason)
  if (liveState.live && captureConsent.canAutoStart) {
    captureFault = 'capture renderer crashed — recovering'
    refreshTray()
  }
  if (captureWindow && !captureWindow.isDestroyed()) {
    captureWindow.webContents.reload() // re-runs the renderer → it re-pings capture:loaded
  }
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

/** Route a per-source IPC message (segment/stopped/status) to the controller that owns that source. Screen */
/** never uses these IPC channels (it's grabbed in the main process), so only the two audio sources map here. */
const controllerFor = (source: CaptureSourceKind): CaptureController | undefined =>
  source === 'mic' ? micController : source === 'system-audio' ? systemController : undefined

/**
 * Screen-Recording permission on macOS. There is NO `askForMediaAccess('screen')` counterpart to the mic
 * — the TCC prompt appears the first time desktopCapturer actually grabs a frame. So we only hard-block
 * when the status is ALREADY 'denied'/'restricted' (→ the controller's honest 'denied' state, never a
 * false "capturing"); 'granted' and 'not-determined' proceed and let the first grab surface the prompt
 * (until granted, macOS returns an empty image, which captureScreenFrame skips). Non-macOS has no gate.
 */
const requestScreenPermission = async (): Promise<boolean> => {
  if (process.platform !== 'darwin') return true
  try {
    const status = systemPreferences.getMediaAccessStatus('screen')
    console.log(`[shell] screen access status before capture: ${status}`)
    return status !== 'denied' && status !== 'restricted'
  } catch (err) {
    console.error('[shell] screen permission check failed:', err)
    return false
  }
}

/**
 * Grab ONE still frame of the primary display via desktopCapturer (MAIN process — no getUserMedia, no
 * hidden renderer, no picker) and hand it to the screen controller as a RawSegment. CHOSEN over
 * getDisplayMedia-in-a-renderer because it adds zero renderer/canvas plumbing and no
 * session.setDisplayMediaRequestHandler, and NativeImage gives us JPEG bytes + the exact pixel size
 * directly; the honest cost — each poll is a full capture — is fine at a ~5s still-frame cadence (we are
 * NOT streaming video). We request a thumbnail at the display's PHYSICAL pixel size (logical × scaleFactor)
 * so retina screens capture at real resolution, then read the produced image's actual size for the
 * ScreenFrameMeta. An EMPTY image = the Screen-Recording grant hasn't landed yet (macOS returns black/empty
 * until granted) → skip the frame rather than ship a black rectangle. The HUD window is
 * setContentProtection(true)/NSWindowSharingNone, so it excludes ITSELF from the capture.
 * Δ-gating (only keep changed frames) is deliberately future — every cadence tick is kept for now.
 */
const captureScreenFrame = async (): Promise<void> => {
  const controller = screenController
  if (!controller) return
  try {
    const primary = screen.getPrimaryDisplay()
    const scale = primary.scaleFactor || 1
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(primary.size.width * scale), height: Math.round(primary.size.height * scale) },
    })
    const primaryId = String(primary.id)
    const source = sources.find((s) => s.display_id === primaryId) ?? sources[0]
    const image = source?.thumbnail
    if (!image || image.isEmpty()) return // no frame yet — Screen-Recording grant likely still pending
    const size = image.getSize()
    const jpeg = image.toJPEG(70) // ~0.7 quality — still frames, not video
    // Copy into a fresh, exactly-sized ArrayBuffer (a Node Buffer's .buffer is a shared pool typed
    // ArrayBuffer|SharedArrayBuffer; RawSegment.bytes is a plain ArrayBuffer).
    const bytes = new Uint8Array(jpeg).buffer
    await controller.onSegment({
      source: 'screen',
      bytes,
      mimeType: 'image/jpeg',
      capturedAt: new Date().toISOString(),
      screenMeta: { displayId: source?.display_id || primaryId, width: size.width, height: size.height, scale },
    })
  } catch (err) {
    console.error('[shell] screen frame capture failed:', err)
  }
}

/** control.start for screen: grab a frame now (so the first isn't a full interval away), then on cadence. */
const startScreenLoop = (): void => {
  if (screenTimer) return
  void captureScreenFrame()
  screenTimer = setInterval(() => void captureScreenFrame(), cfg.screenIntervalMs)
}

/**
 * control.stop for screen: stop the cadence and confirm the stop on the next tick. Unlike the audio
 * renderer there is no async final-segment flush (each grab is a self-contained frame), but the controller
 * still needs onCaptureStopped to complete its stopping→idle handshake (and honor any queued restart), so
 * we defer it via setImmediate to mirror the audio path's asynchronous `stopped` signal.
 */
const stopScreenLoop = (): void => {
  if (screenTimer) {
    clearInterval(screenTimer)
    screenTimer = undefined
  }
  setImmediate(() => void screenController?.onCaptureStopped())
}

/**
 * Build the capture controllers (one per source — mic "me" + system-audio "them") and wire the shared
 * renderer IPC. Both drive the ONE hidden window over source-tagged channels; the session lifecycle
 * drives both. The mic path is unchanged from the mic-only slice; system-audio rhymes with it and only
 * activates when a BlackHole-like device is present (else it reports no-device and stays a silent no-op).
 */
/**
 * A capture start could not be delivered (the dispatcher exhausted its retries — the renderer never
 * acked). Surface it VISIBLY on the tray, log it to the client file, and reset the affected controller
 * so it stops claiming a warming-up capture. This is the "no silent drop" guarantee (issue #41): the
 * old path logged to a lost stdout and left the controller stuck in `starting`.
 */
const onCaptureFault = (source: CaptureSourceKind, reason: string): void => {
  captureFault = reason
  clientLog(`[shell] ${source} capture fault surfaced to tray: ${reason}`)
  controllerFor(source)?.onStartFailed(reason)
  refreshTray()
}

const setupCapture = (): void => {
  engineLink = new EngineLink({ baseUrl: cfg.engineUrl, spoolDir: path.join(app.getPath('userData'), 'capture-spool') })
  engineLink.startFlushLoop() // drain spooled chunks once the engine is reachable again (offline-safe)
  const link = engineLink
  // The readiness/ack handshake (issue #41): every audio start flows through here, gated on the hidden
  // renderer having pinged `capture:loaded` and acked the start — no more fire-and-forget send that
  // could race the renderer's listener registration and vanish. A start unacked after retries becomes a
  // VISIBLE tray fault + resets the controller (onCaptureFault) instead of a silent forever-`starting`.
  const dispatcher = new CaptureDispatcher({
    send: (channel: DispatchChannel, source: CaptureSourceKind) =>
      captureWindow?.webContents.send(channel === 'start' ? CAPTURE_CHANNELS.start : CAPTURE_CHANNELS.stop, source),
    onFault: onCaptureFault,
    log: clientLog,
  })
  captureDispatcher = dispatcher
  micController = new CaptureController({
    source: 'mic',
    enabled: cfg.micEnabled,
    capture: (chunk) => link.capture(chunk),
    control: {
      start: () => dispatcher.requestStart('mic'),
      stop: () => dispatcher.requestStop('mic'),
    },
    requestPermission: sharedAudioPermission,
    onStateChange: (state) => {
      micState = state
      refreshTray()
    },
    log: clientLog,
  })
  systemController = new CaptureController({
    source: 'system-audio',
    enabled: cfg.systemAudioEnabled,
    capture: (chunk) => link.capture(chunk),
    control: {
      start: () => dispatcher.requestStart('system-audio'),
      stop: () => dispatcher.requestStop('system-audio'),
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
    log: clientLog,
  })
  // Screen ("what's on screen") — grabbed in the MAIN process, so its control is the desktopCapturer
  // cadence loop above rather than an IPC send to the hidden renderer. Opt-IN (default OFF) and driven by
  // the SAME session lifecycle; frames spool through EngineLink.capture like audio (a lost frame is real
  // data loss, not ephemeral). No onSilence — that is audio-only.
  screenController = new CaptureController({
    source: 'screen',
    enabled: cfg.screenEnabled,
    capture: (chunk) => link.capture(chunk),
    control: { start: startScreenLoop, stop: stopScreenLoop },
    requestPermission: requestScreenPermission,
    onStateChange: (state) => {
      clientLog(`[shell] screen capture state → ${state}`)
      refreshTray()
    },
    log: clientLog,
  })
  ipcMain.on(CAPTURE_CHANNELS.segment, (_event, segment: RawSegment) => void controllerFor(segment.source)?.onSegment(segment))
  ipcMain.on(CAPTURE_CHANNELS.stopped, (_event, source: CaptureSourceKind) => void controllerFor(source)?.onCaptureStopped())
  ipcMain.on(CAPTURE_CHANNELS.status, (_event, status: CaptureStatus) => controllerFor(status.source)?.onStatus(status))
  // The readiness handshake IPC (issue #41): the renderer pings `loaded` on module load and acks each
  // start. `loaded` flushes any queued starts; a crash-recovery reload re-arms capture for a live session.
  ipcMain.on(CAPTURE_CHANNELS.loaded, () => {
    dispatcher.markLoaded()
    if (captureRendererCrashed) {
      captureRendererCrashed = false
      captureFault = undefined
      clientLog('[shell] capture renderer reloaded — re-arming capture if a consented session is live')
      if (liveState.live && captureConsent.canAutoStart) applyCaptureLifecycle(true)
      refreshTray()
    }
  })
  ipcMain.on(CAPTURE_CHANNELS.startAck, (_event, source: CaptureSourceKind) => dispatcher.ackStart(source))
  console.log(
    `[shell] mic capture ${cfg.micEnabled ? 'enabled' : 'disabled by config'} · system-audio ${cfg.systemAudioEnabled ? 'enabled' : 'disabled by config'} · screen ${cfg.screenEnabled ? `enabled (every ${cfg.screenIntervalMs}ms)` : 'disabled by config (opt-in)'} (all follow the session lifecycle)`,
  )
}

/**
 * Mirror the session's live state into BOTH capture sources: a live session starts mic + system-audio
 * (its ids tag the chunks), ending it stops + flushes each final segment. This is the whole "the tray
 * toggle is the capture switch, zero new UI" wiring — capture strictly follows the session the tray
 * already controls. System-audio self-resolves to a no-op if no BlackHole-like device is present.
 */
const applyCaptureLifecycle = (live: boolean): void => {
  if (live) {
    // BOOT GUARD (issue #41): a live-session transition only drives capture when the user explicitly
    // started a session THIS launch. A leftover session seeded at boot (a force-killed prior client, or
    // a quit that could not end it in time) reads consent=false here, so the app opens STOPPED and the
    // stale session is never silently resumed — the tray still shows it live; the user starts capture.
    if (!captureConsent.canAutoStart) {
      clientLog('[shell] live session present but capture consent not granted this launch — NOT auto-starting capture (start a session to capture)')
      return
    }
    const sessionId = liveState.liveSessionId
    if (sessionId) {
      const context = { sessionId, workspaceId: cfg.workspace }
      void micController?.onSessionStarted(context)
      void systemController?.onSessionStarted(context)
      void screenController?.onSessionStarted(context) // opt-in; a no-op unless cfg.screenEnabled
    }
  } else {
    micController?.onSessionEnded()
    systemController?.onSessionEnded()
    screenController?.onSessionEnded()
  }
}

const execFileAsync = promisify(execFile)

/**
 * Read the frontmost app + window title on macOS via `osascript` (System Events) — the ONE electron/OS
 * edge of focus capture, kept thin (like the capture renderer) and out of CI. CHOSEN over a native
 * module (active-win lineage) for v0 because it adds ZERO dependencies and no native prebuilds to trust
 * for Electron 38 / macOS 26; the honest cost is a TCC grant.
 *
 * TCC: System Events reading another app's process/window needs **Accessibility** permission (System
 * Settings → Privacy & Security → Accessibility → enable the running app — Electron in dev, the packaged
 * app in prod). Until granted, osascript errors and this returns undefined (the poller keeps its last
 * state, emits nothing — no crash, no partial signal). On modern macOS some window TITLES may be further
 * gated (Screen Recording); the app NAME is the reliable floor. FUTURE: a reviewed native reader (a
 * CoreGraphics/Accessibility module) replaces this behind the same `sample()` seam — swapping only HOW
 * the frontmost window is read, not the poller/redaction/gating around it.
 */
const FRONTMOST_SCRIPT = [
  'tell application "System Events"',
  '  set frontApp to first application process whose frontmost is true',
  '  set appName to name of frontApp',
  '  set winTitle to ""',
  '  try',
  '    set winTitle to name of front window of frontApp',
  '  end try',
  'end tell',
  'return appName & "\n" & winTitle',
].join('\n')

const readFrontmostWindow = async (): Promise<FrontmostWindow | undefined> => {
  if (process.platform !== 'darwin') return undefined // Windows/Linux readers are a later slice (out of scope)
  const { stdout } = await execFileAsync('osascript', ['-e', FRONTMOST_SCRIPT], { timeout: 2000 })
  const [app, ...rest] = stdout.split('\n')
  const appName = app?.trim()
  if (!appName) return undefined
  const windowTitle = rest.join('\n').trim()
  return windowTitle ? { app: appName, windowTitle } : { app: appName }
}

/**
 * Build the focus poller and reflect its active state into the tray. Focus capture is CONTEXT, not
 * media: no hidden renderer, no session — it watches the foreground window to feed the engine's
 * context-switch detector, gated on the engine's route.detect flag (fetched on connect, re-checked on
 * `flag.changed`) AND the local OPENINFO_FOCUS opt-out. Emits via captureEphemeral (never spooled —
 * stale focus is noise). Requires engineLink (built in setupCapture), so this runs after it.
 */
const setupFocus = (): void => {
  const link = engineLink
  if (!link) return
  const runId = `${process.pid.toString(36)}-${Date.now().toString(36)}`
  // Wrap the OS read to observe context-detection HEALTH: if we're actively watching but never get a
  // window title (osascript read failing, or titles empty), the tray offers the "Grant Accessibility…"
  // fix-it. This never changes what focus emits — it only watches the outcome. See context-health.ts.
  const sample = async (): Promise<FrontmostWindow | undefined> => {
    const before = contextHealth.needsAccessibility
    let window: FrontmostWindow | undefined
    try {
      window = await readFrontmostWindow()
    } catch (err) {
      contextHealth.observe(undefined) // read threw (Accessibility likely denied) — count it as title-less
      if (contextHealth.needsAccessibility !== before) refreshTray()
      throw err // preserve the poller's keep-last-state-on-error semantics
    }
    contextHealth.observe(window)
    if (contextHealth.needsAccessibility !== before) refreshTray()
    return window
  }
  focusPoller = new FocusPoller({
    sample,
    emit: (chunk) => link.captureEphemeral(chunk),
    workspaceId: cfg.workspace,
    runId,
    enabled: cfg.focusEnabled,
    onActiveChange: (active) => {
      focusActive = active
      contextHealth.setActive(active) // reset the health window when watching stops/starts
      refreshTray()
    },
    log: (message) => console.log(message),
  })
  console.log(`[shell] focus capture ${cfg.focusEnabled ? 'enabled' : 'disabled by config'} — idle until the engine's route.detect flag is on`)
}

/** Apply the engine's route.detect flag to the poller (from the initial /flags read or a flag.changed event). */
const applyDetectFlag = (on: boolean): void => {
  focusPoller?.setDetectEnabled(cfg.focusEnabled && on)
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
      // The route.detect flag was flipped (PUT /flags/route.detect) — start/stop focus watching live,
      // without a refetch (the event carries the Flag; its `default` is the effective value).
      if (parsed.name === 'flag.changed' && parsed.payload) {
        const flag = parsed.payload as Flag
        if (flag.key === ROUTE_DETECT_FLAG) applyDetectFlag(flag.default)
      }
    } catch {
      /* ignore malformed frames */
    }
  })
  socket.addEventListener('close', () => setTimeout(connectEvents, 1500)) // reconnect + re-seed below
  socket.addEventListener('open', () => void seedSessionState())
}

/**
 * The proactive first-LAUNCH microphone ask: on the very first open (a once-only persisted `micPromptedAt`
 * gate), fire askForMediaAccess('microphone') so the user sees the mic TCC popup at first open like any
 * capture app — NOT only when a session later starts (the old behaviour, gated behind session.started).
 * Non-blocking and harmless: a denial doesn't break anything (the capture paths already degrade to a
 * mic-off session). Independent of engine/model state so it fires even before onboarding; it runs in
 * whenReady, so it precedes any /settings auto-open. macOS-only — off darwin askForMediaAccess resolves
 * true with no popup, so we skip and don't burn the once-only marker.
 */
const maybeAskMicOnFirstLaunch = (): void => {
  if (process.platform !== 'darwin') return
  const userData = app.getPath('userData')
  const alreadyPrompted = readFirstRunState(userData).micPromptedAt !== undefined
  if (!shouldPromptMic({ alreadyPrompted })) return
  markMicPrompted(userData, new Date().toISOString()) // once-only: mark before asking so a crash can't re-nag
  console.log('[shell] first launch — proactively asking for microphone access (once), before any /settings open')
  // Reuse the shared in-flight dedup so a session that starts mid-prompt awaits this same ask, not a second.
  void sharedAudioPermission()
    .then((granted) => {
      console.log(`[shell] first-launch mic ask resolved: ${granted ? 'granted' : 'not granted — capture degrades, session/text unaffected'}`)
      refreshTray() // the readout's mic line now reflects the user's choice
    })
    .catch((err) => console.error('[shell] first-launch mic ask failed:', err))
}

/**
 * First-run assembly: the FIRST time we reach the engine and find its llm slot empty (needsModelSetup),
 * open /setup in the browser so a brand-new user lands on onboarding without hunting the tray — but at
 * most ONCE per fresh state (a `firstRunShownAt` timestamp is persisted client-local; the ⚠ tray
 * prominence stays as the always-available nudge thereafter). Engine unreachable ⇒ nothing to open (the
 * tray leads with the unreachable state instead). Guarded so it never nags twice. See first-run.ts.
 */
const maybeOpenFirstRunSetup = (): void => {
  if (firstRunChecked || !connected) return
  const userData = app.getPath('userData')
  const alreadyShown = readFirstRunState(userData).firstRunShownAt !== undefined
  if (shouldOpenSetup({ engineReachable: connected, needsModelSetup: needsSetup, alreadyShown })) {
    firstRunChecked = true
    const now = new Date().toISOString()
    markFirstRunShown(userData, now)
    console.log('[shell] first run — llm slot empty, opening /settings once (Get started leads)')
    // /settings auto-selects the Get-started section when the llm slot is empty (the first-run condition).
    void electronShell.openExternal(`${cfg.engineUrl}/settings`).catch((err) => console.error('[shell] open settings (first run) failed:', err))
  } else if (needsSetup !== undefined) {
    // Reached the engine and we KNOW the setup state (already shown, or a model exists) — done for this run.
    firstRunChecked = true
  }
}

/**
 * The engine-spawn seam — the one thing that keeps a double-clicked .app from being a dead shell. Decide,
 * ONCE at startup: if the configured engine URL already answers /health, ADOPT it (the dev-rig case — the
 * owner runs an engine on :8787 — spawn nothing, and never kill it). If nothing answers and we shipped a
 * bundled engine, SPAWN it and wait for it to serve. If neither, do nothing — the tray's existing
 * "engine unreachable" leading state is the honest fallback. Best-effort throughout: a failed spawn or a
 * child that never answers degrades to that same unreachable state, never a crash. The decision logic +
 * health polling are pure (engine-supervisor.ts, tested headless); this is only the electron plumbing.
 */
const ensureEngine = async (): Promise<void> => {
  const reachable = await checkEngineReachable(cfg.engineUrl)
  const entry = bundledEngineEntry(process.resourcesPath)
  const bundledEnginePresent = existsSync(entry)
  const disposition = decideEngineDisposition({ reachable, bundledEnginePresent })
  engineDisposition = disposition
  console.log(`[shell] engine ${cfg.engineUrl}: reachable=${reachable} bundled=${bundledEnginePresent} → ${disposition}`)
  if (disposition === 'adopt') {
    // Adopted an already-running engine (the dev-rig case) — read its version so the tray can surface it
    // and flag skew (a stale engine that predates our fixes reads as "older than this app"). Best-effort.
    engineHealth = await fetchEngineHealth(cfg.engineUrl)
    console.log(`[shell] adopted engine version: ${engineHealth.version ?? 'unknown (predates the /health version field)'}`)
    return
  }
  if (disposition !== 'spawn') return // unreachable — the tray leads with the unreachable state; spawn nothing
  const port = portFromEngineUrl(cfg.engineUrl)
  try {
    // Electron's utilityProcess runs the engine in a Node child on Electron's OWN bundled Node runtime — so
    // there is NO second Node binary to ship, and the bundled better-sqlite3 need only match Electron's ABI
    // (staged, rebuilt for it, by package.mjs). Data dir stays the engine's default (~/.openinfo/data); we
    // pin only the PORT so the child answers the exact URL the client talks to. stdio piped so the engine's
    // log rides ours.
    const child = utilityProcess.fork(entry, [], {
      env: { ...process.env, OPENINFO_PORT: String(port) },
      stdio: 'pipe',
      serviceName: 'openinfo-engine',
    })
    child.stdout?.on('data', (d: Buffer) => process.stdout.write(`[engine] ${d}`))
    child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[engine] ${d}`))
    child.on('exit', (code) => {
      console.log(`[shell] bundled engine exited (code ${code})`)
      if (spawnedEngine === child) spawnedEngine = undefined
    })
    spawnedEngine = child
    console.log(`[shell] spawned bundled engine (pid ${child.pid}) on :${port} — waiting for health…`)
    const up = await waitForEngine(cfg.engineUrl)
    console.log(up ? '[shell] bundled engine is serving' : '[shell] bundled engine did not answer in time — tray shows unreachable')
    if (up) engineHealth = await fetchEngineHealth(cfg.engineUrl) // the bundled engine reports its own version
  } catch (err) {
    console.error('[shell] failed to spawn bundled engine:', err) // leave the unreachable state as the fallback
  }
}

const seedSessionState = async (): Promise<void> => {
  try {
    liveState.seed(await session.liveSession(cfg.workspace))
    connected = true
  } catch (err) {
    console.error('[shell] could not reach engine for session state:', err)
    connected = false
  } finally {
    engineTried = true
  }
  // Seed the "Set up models…" prominence from the live fabric (best-effort — a failure just leaves
  // the nudge quiet rather than crashing the tray).
  try {
    needsSetup = needsModelSetup(await session.fabric())
  } catch (err) {
    console.error('[shell] could not read fabric for setup nudge:', err)
  }
  // Seed focus watching from the engine's route.detect flag (best-effort — a failure just leaves focus
  // idle rather than crashing). The WS `flag.changed` handler keeps it fresh after this.
  try {
    if (engineLink) applyDetectFlag(detectEnabledFrom(await engineLink.flags()))
  } catch (err) {
    console.error('[shell] could not read flags for focus gating:', err)
  }
  maybeOpenFirstRunSetup()
  refreshTray()
}

// No single-instance lock, no guard: a second launch (stray process, double-click, a relaunch that
// raced a not-yet-dead prior one) would create its own Tray, so the menu bar shows two of us.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()

app.on('second-instance', () => showHud())

app.whenReady().then(async () => {
  if (!gotLock) return
  app.dock?.hide() // menu-bar-only agent (no dock icon), like a Glass-style companion
  // Give the shell + capture lifecycle a durable log now that userData is resolvable (issue #41). The
  // packaged .app has no terminal; without this the whole capture-failure class is invisible.
  clientLog = createClientLog({ file: path.join(app.getPath('userData'), 'logs', 'client.log') })
  clientLog(`[shell] launch — engine ${cfg.engineUrl}, workspace ${cfg.workspace}, capture opens STOPPED until you start a session`)
  // Grant only the media (mic) permission at the Chromium layer for our own windows; deny everything
  // else. The OS-level (TCC) gate is separate — requestMicPermission handles that before capture.
  electronSession.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'media'))
  liveState.onChange((live) => {
    refreshTray()
    applyCaptureLifecycle(live)
  })
  ipcMain.on('hud:drag-start', () => startWindowDrag())
  ipcMain.on('hud:drag-end', () => endWindowDrag())
  ipcMain.on('hud:resize', (_event, height: number) => resizeHudToContent(height))
  createHudWindow()
  createCaptureWindow()
  createTray()
  setupCapture()
  setupFocus()
  maybeAskMicOnFirstLaunch() // fire the once-only mic TCC popup at first open, before any /settings auto-open
  // Adopt-or-spawn the engine BEFORE seeding, so a fresh double-clicked app has its bundled engine serving
  // by the time the tray reads session/fabric state. Awaited (best-effort) — the WS reconnect + re-seed
  // still recover if the engine comes up later or the spawn is slow.
  await ensureEngine()
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
// Guards the one-shot async quit path below so preventDefault → endSession → quit does not loop.
let quitFinalizing = false
app.on('before-quit', (event) => {
  micController?.shutdown() // stop all capture cleanly if quitting mid-capture
  systemController?.shutdown()
  screenController?.shutdown() // clears the desktopCapturer cadence loop
  focusPoller?.stop() // stop watching the foreground window
  captureConsent.revoke() // never let a quit be read as consent to auto-resume next launch
  // END THE SESSION ON QUIT (issue #41): a session must not outlive the client and auto-capture on the
  // next boot. Best-effort + BOUNDED so quit never hangs — we hold the quit briefly for the end POST to
  // land, then finalize regardless. The boot guard above is the deterministic backstop if this never
  // runs (a force-kill) — either way the next launch opens STOPPED.
  const id = liveState.liveSessionId
  if (id && !quitFinalizing) {
    quitFinalizing = true
    event.preventDefault()
    clientLog(`[shell] quitting — ending live session ${id} so it does not auto-resume next launch`)
    const finalize = (): void => {
      spawnedEngine?.kill() // shut down ONLY the engine we spawned; an adopted engine is left running
      app.quit()
    }
    void Promise.race([
      session.endSession(id).catch((err) => clientLog(`[shell] end session on quit failed: ${String(err)}`)),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]).finally(finalize)
    return
  }
  spawnedEngine?.kill() // shut down ONLY the engine we spawned; an adopted engine is left running
})
app.on('will-quit', () => globalShortcut.unregisterAll())
