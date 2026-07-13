import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, screen, nativeImage, session as electronSession, shell as electronShell, systemPreferences, desktopCapturer, utilityProcess, type UtilityProcess, type MenuItemConstructorOptions } from 'electron'
import type { Fabric, Flag } from '@openinfo/contracts'
import { resolveShellConfig, loadClientConfigFile, type ShellConfig } from './config.js'
import { decideEngineDisposition, checkEngineReachable, waitForEngine, bundledEngineEntry, portFromEngineUrl, fetchEngineHealth, engineStatusLine, assessEngineSkew, parseAllowSkew, readBuildStamp, type EngineDisposition, type EngineHealth } from './engine-supervisor.js'
import { systemFaceDataUrl, type SystemFaceModel } from './system-face.js'
import { surfaceWindowSpec, configForSurface, windowTitleFor, assertWindowContract, HUD_MIN_HEIGHT, type HudWindowSpec, type WindowChrome } from './window-options.js'
import { resolveHudHeight } from './hud-height.js'
import { buildTrayMenu, trayTooltip, type TrayState, type TrayMenuItem } from './tray-menu.js'
import { SHORTCUTS, type ShellCommand } from './shortcuts.js'
import { WindowRegistry } from './app-registry.js'
import { readAppState, writeAppState, toggleInList, type AppState } from './app-store.js'
import type { AppSurface, AppBundle } from './app-catalog.js'
import { settingsUrlFor, isLanEngine } from './permission-help.js'
import { ContextHealthTracker } from './context-health.js'
import { shouldOpenSetup, shouldPromptMic } from './first-run.js'
import { readFirstRunState, markFirstRunShown, markMicPrompted } from './first-run-store.js'
import { captureStatuses, type MediaAccessStatus, type SysAudioPresence, type EngineSenseVerdict } from './capture-status.js'
import { EngineSessionClient, SessionLiveState, needsModelSetup } from './engine-session.js'
import { TRAY_ICON_TEMPLATE_1X, TRAY_ICON_TEMPLATE_2X, trayIconBuffer } from './tray-icon.js'
import { grabOffset, draggedOrigin, resolveStartupPosition, type ScreenPoint } from './window-position.js'
import { readSavedPosition, savePosition } from './window-store.js'
import { EngineLink } from '../engine-link/index.js'
import { CaptureController, type CaptureState } from '../capture/capture-controller.js'
import { CAPTURE_CHANNELS, type CaptureSourceKind, type CaptureStatus, type RawSegment } from '../capture/protocol.js'
import { startScreenCadence, type ScreenCadenceHandle } from '../capture/screen-source.js'
import { FrameDeltaGate, DELTA_PROBE_WIDTH } from '../capture/frame-delta.js'
import { runScreenCaptureAttempt } from '../capture/screen-observation.js'
import { CaptureConsent } from './capture-consent.js'
import { CaptureDispatcher, type DispatchChannel } from './capture-dispatcher.js'
import { createClientLog, type ClientLog } from './client-log.js'
import { FocusPoller, detectEnabledFrom, ROUTE_DETECT_FLAG } from '../capture/focus-poller.js'
import type { FrontmostWindow } from '../capture/focus.js'
import {
  configuredEngineCredentialSource,
  engineWebSocketProtocols,
  fetchEngineControl,
  type EngineFetchLike,
} from './engine-auth.js'
import {
  RendererEngineAuth,
  pinTrustedSurface,
  requestBrowserSettingsTicket,
  type ElectronWebRequestLike,
} from './renderer-engine-auth.js'

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

// System-audio loopback (#142): opt into Chromium's macOS CoreAudio-Tap so getDisplayMedia's `audio:'loopback'`
// captures the system mix WITHOUT a virtual device. It is the default from Electron v39; on v38 it is
// explicit. Must be appended before app-ready, so it lives here at module init. Only relevant when the
// system-audio method is loopback (macOS default) — harmless otherwise (no getDisplayMedia loopback call).
if (cfg.systemAudioMethod === 'loopback') {
  app.commandLine.appendSwitch('enable-features', 'MacCatapLoopbackAudioForScreenShare')
}

const engineCredentials = configuredEngineCredentialSource(cfg.engineUrl)
const session = new EngineSessionClient(cfg.engineUrl, undefined, engineCredentials)
const rendererEngineAuth = new RendererEngineAuth(cfg.engineUrl, engineCredentials)
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
// Per-window binding + chrome (#19/#20). The drag/resize IPC is routed by `event.sender` to the window
// that sent it; this map tells the shell that window's surface id, whether it is a content-sized,
// drag-follow HUD-style window or a normal framed app window, and whether it is the singular default HUD.
const windowMeta = new WeakMap<BrowserWindow, { surfaceId: string; chrome: WindowChrome; isDefaultHud: boolean }>()
// The app surfaces the engine serves (GET /layouts/surfaces) — feeds the tray Apps folder. Empty until fetched.
let appSurfaces: AppSurface[] = []
// The app bundles the engine serves (GET /bundles) — each renders as ONE app in the Apps folder whose faces
// open the mapped surfaces (bundle-as-runtime-object). Empty until fetched; a surface not claimed by a
// bundle face is demoted to a standalone catalog row (see app-catalog.ts).
let appBundles: AppBundle[] = []
// Client-local Apps-folder state: favorites (float to top), the open-window set (reopened next launch),
// and per-app window positions (#19/#20/#98). Loaded from apps-state.json in whenReady; see app-store.ts.
let appState: AppState = { favorites: [], openApps: [], positions: {} }
// Per-app-window debounced position savers — a HUD-style app window persists where the user drags it (#20).
const appSaveTimers = new Map<BrowserWindow, ReturnType<typeof setTimeout>>()
// True once the app is quitting — so the cascade of app-window `closed` events during teardown does NOT
// rewrite the persisted open-set to empty (the set must survive so those windows reopen next launch, #19).
let shuttingDown = false
// The engine child WE spawned (only when the configured URL answered nothing AND we shipped a bundled
// engine). Undefined when we adopted an already-running engine — so we NEVER kill an engine we didn't
// start; only this child is shut down, on quit. See engine-supervisor.ts + ensureEngine.
let spawnedEngine: UtilityProcess | undefined
// The engine version handshake captured at startup: which engine we ended up on (adopt/spawn/unreachable)
// and its reported version/build. Feeds the tray's "engine v0.0.1 · adopted at :8787" info line + skew
// note. Undefined until ensureEngine resolves. See engine-supervisor.ts (pure, tested headless).
let engineDisposition: EngineDisposition | undefined
let engineHealth: EngineHealth = {}
// This app's own build id (git short sha), read once from the packaged build stamp. Undefined in a dev run
// (no packaged resources). Forwarded to a spawned engine as OPENINFO_BUILD and shown on the System face.
let appBuild: string | undefined
// The skew-refusal state (S6): the plain-language reason a reachable engine was DECLINED for a version/build
// mismatch. Set only when we refused (mismatch AND no dev flag); the shell then does not seed/drive sessions
// through it, the tray leads with the refusal, and the System window auto-opens with the banner. Undefined
// when there is no skew or skew was dev-allowed (OPENINFO_ALLOW_ENGINE_SKEW).
let skewRefusal: string | undefined
// The System window (S6) — a plain framed window showing version/build for app + engine, plus the skew
// banner. Created on demand (tray "System info…" or auto-opened on a refusal); one at a time.
let systemWindow: BrowserWindow | undefined
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
// The engine-side per-sense gate verdicts (GET /senses, issue #7) — the deeper "why is this sense silent"
// gates (processing flags, stt/ocr slot, endpoint health) the client cannot see itself. Fed into the
// capture-status readout so the tray names the FIRST blocking gate across the whole chain. Undefined until
// fetched (engine unreachable / old engine) — then the tray simply shows the client-side gates it knows.
let senseGates: EngineSenseVerdict[] | undefined
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
// The screen cadence loop's handle (issue #4) — startScreenCadence drives the grab timer at the
// config-resolved, 3–6s-clamped cfg.screenIntervalMs; this holds the running loop so stopScreenLoop can end it.
let screenCadence: ScreenCadenceHandle | undefined
// desktopCapturer + JPEG + durable POST/spool is one atomic attempt. A slow attempt must not overlap the
// next cadence tick and reorder image/meta pairs; the next regular tick will re-announce current truth.
let screenAttemptRunning = false
// The focus (foreground-window context) poller — main-process, session-INDEPENDENT, gated on the
// engine's route.detect flag + the local OPENINFO_FOCUS opt-out. `focusActive` mirrors whether it is
// currently watching, for the tray's quiet "· watching context" tooltip.
let focusPoller: FocusPoller | undefined
let focusActive = false

// Drag state: while a drag is live, `dragTimer` polls the OS cursor and `draggingWindow` rides it,
// keeping `dragOffset` (the grab point within the window) constant. Only one HUD-style window drags at a
// time (the OS cursor is singular); per-window position saves are debounced via `appSaveTimers`.
let dragTimer: ReturnType<typeof setInterval> | undefined
let dragOffset: ScreenPoint | undefined
let draggingWindow: BrowserWindow | undefined

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
    // issue #7: the client-side gates the readout chains in front of the engine-side verdict — sense
    // toggled off (config), engine reachability, and whether a session is live (nothing captures without
    // one). engineGates is the engine's half (GET /senses), undefined until fetched.
    micEnabled: cfg.micEnabled,
    systemAudioEnabled: cfg.systemAudioEnabled,
    systemAudioMethod: cfg.systemAudioMethod, // #142: drives whether the readout names the loopback grant or a virtual device
    engineReachable: connected,
    sessionLive: liveState.live,
    ...(senseGates !== undefined ? { engineGates: senseGates } : {}),
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
  ...(skewRefusal !== undefined ? { engineSkewRefused: skewRefusal } : {}),
  captureStatus: captureStatuses(captureStatusInput()),
  // The Apps folder (#19/#98): the surfaces the engine serves + the user's favorites + which windows are
  // open now. The default HUD is "open" whenever its window is visible (it is the singular anchor, not in
  // the registry); every other open surface comes from the multi-window registry.
  apps: {
    surfaces: appSurfaces,
    bundles: appBundles,
    favorites: appState.favorites,
    openIds: [...appRegistry.openSurfaceIds(), ...(hudWindow?.isVisible() ? [cfg.surfaceId] : [])],
  },
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

const shellEngineFetch = (
  requestPath: string,
  init: { method: string; headers?: Record<string, string>; body?: string } = { method: 'GET' },
) => fetchEngineControl({
  baseUrl: cfg.engineUrl,
  path: requestPath,
  init,
  credentials: engineCredentials,
  fetchImpl: globalThis.fetch as unknown as EngineFetchLike,
})

/** Exchange the bearer in main for a one-use, 30-second browser ticket; never log the returned URL. */
const openEngineSettings = async (context: 'tray' | 'first-run' | 'pill'): Promise<void> => {
  try {
    const ticketUrl = await requestBrowserSettingsTicket({
      baseUrl: cfg.engineUrl,
      credentials: engineCredentials,
      fetchImpl: globalThis.fetch as unknown as EngineFetchLike,
    })
    await electronShell.openExternal(ticketUrl)
  } catch {
    // openExternal failures may reflect their URL; logging the error could leak the one-use ticket.
    console.error(`[shell] open settings (${context}) failed`)
  }
}

const dispatch = (command: ShellCommand): void => {
  // Parameterized app commands (the Apps folder, #19/#98) carry the surface id they act on.
  if (typeof command === 'object') {
    switch (command.kind) {
      case 'open-app':
        return openApp(command.surfaceId)
      case 'close-app':
        return closeApp(command.surfaceId)
      case 'toggle-favorite':
        return toggleFavorite(command.surfaceId)
    }
    return
  }
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
      void openEngineSettings('tray')
      return
    case 'open-system':
      // The System face (S6): version + build for app + engine, plus the skew banner when an engine was
      // refused. A live handler for the tray affordance — no dead menu item (the adopted "handler ↔ text" rule).
      openSystemWindow()
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

/**
 * Create ONE surface window (#19) — the generalized window factory the default HUD and every Apps-folder
 * mini app share. A window is BORN bound to its surface (the id is a frozen URL query param — see hud.ts);
 * multi-window is a REGISTRY of such windows, never a re-binding of one. `chrome` decides the shell: HUD
 * chrome is the inherited Glass signature (frameless, transparent, always-on-top, content-protected,
 * content-sized, drag-follow); `app` chrome is a normal framed/opaque/resizable window (a diagnostics app
 * beside the HUD). The window meta lets the drag/resize IPC (routed by `event.sender`) find this window
 * and know how to treat it. The default HUD keeps its EXACT prior behavior (its own position store, its
 * show/hide, its content-sizing) — see the isDefaultHud branches.
 */
const createSurfaceWindow = (
  surfaceId: string,
  opts: { chrome: WindowChrome; isDefaultHud: boolean; startVisible: boolean },
): BrowserWindow => {
  // The window CONTRACT (policy item 3), enforced HERE in the one factory: every surface window either
  // resizes or provably fits its content (S5), AND self-identifies with a non-empty title (S4). A surface
  // added with a clipping fixed width or no identity fails LOUDLY at create, never shipping a broken window.
  assertWindowContract(surfaceId)
  // The full window spec is resolved from the surface's declared config in ONE place (chrome, width, AND the
  // per-surface focusability override, S1) so the shell and the driven e2e build the identical window.
  const spec: HudWindowSpec = surfaceWindowSpec(surfaceId, { startVisible: opts.startVisible })
  const window = new BrowserWindow({
    ...spec.browserWindow,
    // Self-identify (S4): stamp the per-surface title so a booting window is never mislabeled "HUD" (every
    // window loads the SAME hud.html, so its shared <title> alone titled them all "HUD"); the renderer then
    // refines it to the loaded surface's live `name` (page-title-updated flows through by default).
    title: windowTitleFor(surfaceId),
    // The one bridge the renderer needs: the drag channel (preload.cts). Nothing node-bound crosses.
    webPreferences: { ...spec.browserWindow.webPreferences, preload: PRELOAD_JS },
  })
  // The shared defaultSession auth listener is deny-by-default: only these built-in HUD/app renderers
  // receive engine credentials, and only after headers leave renderer JS. Revoke the id on destruction.
  pinTrustedSurface(rendererEngineAuth, window.webContents, pathToFileURL(HUD_HTML).toString())
  windowMeta.set(window, { surfaceId, chrome: opts.chrome, isDefaultHud: opts.isDefaultHud })

  // Method-only hardening (no constructor-option equivalent). Benign for app chrome (all false/off), so
  // content-protection + all-workspaces apply unconditionally; always-on-top only when the spec asks for it.
  window.setContentProtection(spec.hardening.contentProtection)
  if (spec.browserWindow.alwaysOnTop) window.setAlwaysOnTop(true, spec.hardening.alwaysOnTopLevel)
  window.setVisibleOnAllWorkspaces(spec.hardening.visibleOnAllWorkspaces, {
    visibleOnFullScreen: spec.hardening.visibleOnFullScreen,
  })
  const tag = opts.isDefaultHud ? 'HUD' : `app ${surfaceId}`
  console.log(`[shell] ${tag} window created — chrome ${opts.chrome}, content-protection: ${spec.hardening.contentProtection ? 'ON' : 'off'}`)

  // Renderer observability: a HUD-style window is TRANSPARENT, so a dead/blank renderer is otherwise
  // indistinguishable from "hidden". Surface load failures, renderer death, and error-level console lines
  // go to the main-process stdout (visible when the .app is launched from a terminal).
  window.webContents.on('did-fail-load', (_event, code, description) =>
    console.error(`[shell] ${tag} page failed to load: ${code} ${description}`))
  window.webContents.on('render-process-gone', (_event, details) =>
    console.error(`[shell] ${tag} renderer gone: ${details.reason} (exitCode ${details.exitCode})`))
  window.webContents.on('console-message', (details) => {
    if (details.level === 'error') console.error(`[${tag}] ${details.message} (${details.sourceId}:${details.lineNumber})`)
  })

  restoreWindowPosition(window)
  // Pass the engine URL + the surface id so the renderer fetches + renders THIS surface's layout (the same
  // per-window binding the single HUD always had). `outline=1` (ShellConfig.hudOutline) draws debug bounds.
  void window.loadFile(HUD_HTML, {
    search: new URLSearchParams({
      engine: cfg.engineUrl,
      surface: surfaceId,
      ...(cfg.hudOutline ? { outline: '1' } : {}),
    }).toString(),
  })
  window.on('moved', () => scheduleSaveWindowPosition(window)) // OS-level moves; the custom drag also persists on drag-end
  return window
}

/** Create the singular default HUD window (boot behavior unchanged: one HUD, ShellConfig.surfaceId). */
const createHudWindow = (): void => {
  hudWindow = createSurfaceWindow(cfg.surfaceId, { chrome: 'hud', isDefaultHud: true, startVisible: false })
  hudWindow.on('closed', () => (hudWindow = undefined))
}

/** The current System-face model — this app's identity, the engine's, and any skew — read live from state. */
const systemFaceState = (): SystemFaceModel => ({
  appVersion: app.getVersion(),
  ...(appBuild !== undefined ? { appBuild } : {}),
  ...(engineDisposition !== undefined ? { engineDisposition } : {}),
  ...(engineHealth.version !== undefined ? { engineVersion: engineHealth.version } : {}),
  ...(engineHealth.build !== undefined ? { engineBuild: engineHealth.build } : {}),
  engineUrl: cfg.engineUrl,
  ...(skewRefusal !== undefined ? { skew: { refused: true, reason: skewRefusal } } : {}),
})

/**
 * Open (or focus + refresh) the System window (S6) — a plain framed window that answers "which version +
 * build am I running, and is my engine the one I expect?" It renders a self-contained data: URL built from
 * the pure systemFaceDataUrl, so there is no HTML host, no preload, and nothing external to fetch. Auto-opened
 * on a skew refusal (the banner is the fix-it), and reachable any time from the tray's "System info…" item.
 */
const openSystemWindow = (): void => {
  if (systemWindow && !systemWindow.isDestroyed()) {
    void systemWindow.loadURL(systemFaceDataUrl(systemFaceState())) // refresh with the latest facts
    systemWindow.show()
    systemWindow.focus()
    return
  }
  systemWindow = new BrowserWindow({
    width: 460,
    height: 340,
    title: 'openinfo — System',
    resizable: true,
    fullscreenable: false,
    minimizable: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false }, // display-only; no bridge needed
  })
  systemWindow.on('closed', () => (systemWindow = undefined))
  void systemWindow.loadURL(systemFaceDataUrl(systemFaceState()))
  systemWindow.once('ready-to-show', () => systemWindow?.show())
}

/**
 * The multi-window app registry (#19) — every surface window BEYOND the default HUD, keyed by surface id.
 * `create` builds a window with the surface's declared chrome (configForSurface); `focus` reveals it
 * (a HUD-style window shows without stealing focus — a glance; a framed app takes focus like a real
 * window); `close` closes it, and the window's `closed` event calls `retire` so no orphan entry lingers.
 */
const appRegistry = new WindowRegistry<BrowserWindow>({
  create: (surfaceId) => {
    const chrome = configForSurface(surfaceId).chrome
    const window = createSurfaceWindow(surfaceId, { chrome, isDefaultHud: false, startVisible: true })
    window.on('closed', () => {
      appSaveTimers.delete(window)
      appRegistry.retire(surfaceId, window)
      if (shuttingDown) return // quit teardown — keep the persisted open-set so it reopens next launch (#19)
      persistOpenApps()
      refreshTray()
    })
    window.showInactive()
    return window
  },
  focus: (window) => {
    const meta = windowMeta.get(window)
    if (meta?.chrome === 'hud') window.showInactive() // a glance — never steal focus
    else {
      window.show()
      window.focus()
    }
  },
  close: (window) => window.close(),
  isAlive: (window) => !window.isDestroyed(),
})

/** Open (or focus) a surface's window. The default HUD is the singular anchor — its "open" is Show HUD. */
const openApp = (surfaceId: string): void => {
  if (surfaceId === cfg.surfaceId) return showHud() // the default HUD is not in the registry — reveal it
  appRegistry.openOrFocus(surfaceId)
  persistOpenApps()
  refreshTray()
}

/** Close a surface's window. Closing the default HUD's surface HIDES it (the anchor persists, like ⌘\). */
const closeApp = (surfaceId: string): void => {
  if (surfaceId === cfg.surfaceId) return hideHud()
  appRegistry.close(surfaceId) // the window's `closed` handler retires + persists + repaints
}

/** Flip a surface's favorite (client-side, #98) so it floats to the top of the Apps folder; repaint. */
const toggleFavorite = (surfaceId: string): void => {
  appState = { ...appState, favorites: toggleInList(appState.favorites, surfaceId) }
  writeAppState(app.getPath('userData'), appState)
  refreshTray()
}

/** Persist the set of open app windows (#19) so they reopen next launch. The default HUD always reopens. */
const persistOpenApps = (): void => {
  appState = { ...appState, openApps: appRegistry.openSurfaceIds() }
  writeAppState(app.getPath('userData'), appState)
}

/**
 * Reopen the app windows that were open at last quit (#19 — "config persists the set of open surfaces
 * across restart"). The ANCHOR surface (cfg.surfaceId — the window createHudWindow opens directly) is
 * DEDUPED here: it is never reopened as a registry window, because it is already the anchor. This is what
 * keeps the repointed pill anchor honest — a QA-era apps-state may still list surf-openinfo-pill among its
 * openApps (the pill used to open as an Apps-folder window before it became the default), and without this
 * skip that entry would open a DUPLICATE second pill beside the anchor and resurrect forever. The guard is
 * against cfg.surfaceId precisely because that is the id createHudWindow builds the anchor from, so the two
 * can never drift. The reopen feature itself is intact (a note-taker the user left open still returns); a
 * stale id whose surface the engine no longer serves opens a window showing the renderer's honest
 * boot-status text rather than failing invisibly — harmless.
 */
const reopenPersistedApps = (): void => {
  for (const surfaceId of appState.openApps) {
    if (surfaceId === cfg.surfaceId) continue // dedupe: the anchor is already open (createHudWindow)
    appRegistry.openOrFocus(surfaceId)
  }
}

/**
 * Restore a window to where we last left it — the default HUD from its own long-standing store
 * (window-store.ts, unchanged), an app window from the per-surface Apps state (#20). Only if the spot is
 * still on a connected display; otherwise center (the same isPositionUsable guard both share).
 */
const restoreWindowPosition = (window: BrowserWindow): void => {
  const meta = windowMeta.get(window)
  const { width, height } = window.getBounds()
  const displays = screen.getAllDisplays().map((d) => d.workArea)
  const saved = meta?.isDefaultHud
    ? readSavedPosition(app.getPath('userData'))
    : meta
      ? appState.positions[meta.surfaceId]
      : undefined
  const start = resolveStartupPosition(saved, { width, height }, displays)
  if (start) {
    window.setPosition(start.x, start.y)
    console.log(`[shell] ${meta?.isDefaultHud ? 'HUD' : `app ${meta?.surfaceId}`} position restored to ${start.x},${start.y}`)
  } else {
    window.center()
  }
}

/** Persist a window's current origin, debounced so a drag (many move events) writes once it settles (#20). */
const scheduleSaveWindowPosition = (window: BrowserWindow): void => {
  const existing = appSaveTimers.get(window)
  if (existing) clearTimeout(existing)
  appSaveTimers.set(
    window,
    setTimeout(() => {
      appSaveTimers.delete(window)
      if (window.isDestroyed()) return
      const meta = windowMeta.get(window)
      const { x, y } = window.getBounds()
      if (meta?.isDefaultHud) {
        savePosition(app.getPath('userData'), { x, y }) // the default HUD's own store — unchanged behavior
      } else if (meta) {
        appState = { ...appState, positions: { ...appState.positions, [meta.surfaceId]: { x, y } } }
        writeAppState(app.getPath('userData'), appState)
      }
    }, 400),
  )
}

/** Begin following the cursor for a HUD-style window: capture the grab offset, then ride the cursor. */
const startWindowDrag = (window: BrowserWindow): void => {
  if (dragTimer) return
  draggingWindow = window
  const { x, y } = window.getBounds()
  dragOffset = grabOffset(screen.getCursorScreenPoint(), { x, y })
  dragTimer = setInterval(() => {
    if (!draggingWindow || draggingWindow.isDestroyed() || !dragOffset) return
    const next = draggedOrigin(screen.getCursorScreenPoint(), dragOffset)
    draggingWindow.setPosition(next.x, next.y)
  }, 16)
}

/** Stop following the cursor and remember where we ended up. Idempotent (a stray end is a no-op). */
const endWindowDrag = (): void => {
  if (dragTimer) {
    clearInterval(dragTimer)
    dragTimer = undefined
  }
  dragOffset = undefined
  const dragged = draggingWindow
  draggingWindow = undefined
  if (dragged && !dragged.isDestroyed()) scheduleSaveWindowPosition(dragged)
}

/**
 * Content-size a HUD-style window to the panel the renderer just measured (hud:resize, from
 * auto-resize.ts). The transparent window is otherwise a fixed frame whose empty lower portion blocks
 * clicks; sizing it to content removes that dead zone. `measured` is CONTENT height, so setContentSize
 * (not setSize). Top-left origin is left untouched, so the window grows/shrinks downward — drag/position
 * persistence is unaffected. Capped at the display work-area, floored at HUD_MIN_HEIGHT. Only HUD-chrome
 * windows are content-sized; a normal framed app window is left to the user's own resize (its resize IPC
 * is ignored here). Unchanged heights are skipped to avoid churn.
 */
const resizeWindowToContent = (window: BrowserWindow, measured: number): void => {
  if (window.isDestroyed()) return
  if (windowMeta.get(window)?.chrome !== 'hud') return // framed app windows size themselves
  const max = screen.getDisplayMatching(window.getBounds()).workArea.height
  const height = resolveHudHeight(measured, { min: HUD_MIN_HEIGHT, max })
  const [w = 0, currentHeight = 0] = window.getContentSize()
  if (height === currentHeight) return
  window.setContentSize(w, height)
  if (cfg.hudOutline) {
    const b = window.getBounds()
    console.log(`[shell] hud:resize measured=${measured} → content ${w}×${height} · bounds ${b.width}×${b.height} @ ${b.x},${b.y}`)
  }
}

/**
 * The attached-expansion-panel geometry (#134). A panel surface reports the collapsed/expanded content
 * extent along ITS edge — `{height}` for a below-panel (the chat, ~3× its bar), `{width}` for a right
 * sidebar — and we set EXACTLY that axis via setContentSize, keeping the other axis as-is. Top-left origin
 * is left untouched, so a below-panel grows downward and a sidebar grows rightward, exactly like the
 * content-sizer. Each axis is clamped to the display work area. This is the ONE thing only main can do
 * (change window bounds); the renderer's PanelController owns WHEN to expand/collapse (user or suggestion).
 * Applies to whatever window sent it — a panel surface installs the panel bridge instead of auto-resize,
 * so this never fights the content-sizer over an axis.
 */
const resizePanelWindow = (window: BrowserWindow, size: { width?: number; height?: number }): void => {
  if (window.isDestroyed()) return
  const area = screen.getDisplayMatching(window.getBounds()).workArea
  const [currentW = 0, currentH = 0] = window.getContentSize()
  const width = size.width !== undefined ? Math.max(0, Math.min(Math.ceil(size.width), area.width)) : currentW
  const height = size.height !== undefined ? Math.max(0, Math.min(Math.ceil(size.height), area.height)) : currentH
  if (width === currentW && height === currentH) return
  window.setContentSize(width, height)
  if (cfg.hudOutline) {
    const b = window.getBounds()
    console.log(`[shell] hud:panel-size ${JSON.stringify(size)} → content ${width}×${height} · bounds ${b.width}×${b.height} @ ${b.x},${b.y}`)
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
  // System-audio loopback (#142): grant the capture renderer's getDisplayMedia request with system-audio
  // loopback (Chromium CoreAudio-Tap — no virtual device, no routing). We must supply a video source too
  // (getDisplayMedia requires a video request); the renderer immediately drops the video track and keeps
  // only the audio (the system mix). Scoped to THIS hidden window's session so it never affects other
  // windows' media requests. Only the loopback method calls getDisplayMedia, so this is inert for `device`.
  captureWindow.webContents.session.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer
      .getSources({ types: ['screen'] })
      .then((sources) => callback(sources[0] ? { video: sources[0], audio: 'loopback' } : {}))
      .catch((err) => {
        console.error('[shell] loopback getSources failed:', err)
        callback({}) // deny → getDisplayMedia rejects → the renderer reports no-device/permission honestly
      })
  })
  void captureWindow.loadFile(CAPTURE_HTML)
  captureWindow.on('closed', () => (captureWindow = undefined))
  console.log(`[shell] hidden capture window created — mic + system-audio renderer host (system-audio method: ${cfg.systemAudioMethod})`)
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
 * Δ-GATE (issue #5): a static screen is not re-sent every tick. Each grab is scored against the last KEPT
 * frame on a tiny downscaled probe (capture/frame-delta.ts — pure, headless-assertable); an unchanged
 * frame is skipped ENTIRELY (no JPEG encode, no send, no engine OCR) except the safety heartbeat, and a
 * kept frame carries the measured score as ScreenFrameMeta.deltaScore. Threshold from config
 * (cfg.screenDeltaThreshold; 0 = gate off, every tick sends but deltaScore is still stamped).
 */
// Per-display Δ-gate state (last kept probe + tick counter), reset on each session's loop start so a
// session's first frame always sends. Keyed by displayId — primary-only today, multi-display free later.
const frameDeltaGate = new FrameDeltaGate(cfg.screenDeltaThreshold)

/**
 * The ONE desktopCapturer grab both screen paths share: a full-resolution still of the primary display.
 * Returns undefined when no usable frame exists (macOS answers an EMPTY image until the Screen-Recording
 * grant lands) — callers decide what a missing frame means (the cadence skips; the Ask send discloses).
 */
const grabPrimaryDisplayImage = async (): Promise<{ image: Electron.NativeImage; displayId: string; scale: number } | undefined> => {
  const primary = screen.getPrimaryDisplay()
  const scale = primary.scaleFactor || 1
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(primary.size.width * scale), height: Math.round(primary.size.height * scale) },
  })
  const primaryId = String(primary.id)
  const source = sources.find((s) => s.display_id === primaryId) ?? sources[0]
  const image = source?.thumbnail
  if (!image || image.isEmpty()) return undefined // no frame yet — Screen-Recording grant likely still pending
  return { image, displayId: source?.display_id || primaryId, scale }
}

const captureScreenFrame = async (): Promise<void> => {
  const controller = screenController
  const context = controller?.currentContext
  if (!controller || !context || screenAttemptRunning) return
  screenAttemptRunning = true
  try {
    await runScreenCaptureAttempt({
      context,
      // Minted ONCE by runScreenCaptureAttempt before desktopCapturer starts; the same instant becomes the
      // accepted image's capturedAt or the delta/grab outcome's occurredAt. The attempt id remains metadata.
      capture: async ({ occurredAt }) => {
        const grabbed = await grabPrimaryDisplayImage()
        if (!grabbed) return undefined
        const { image, displayId, scale } = grabbed
        // Δ-gate before the expensive steps: the probe (32px-wide resize → raw bitmap) is tiny next to the
        // full-display JPEG encode + send + engine OCR it saves on every static tick.
        const verdict = frameDeltaGate.assess(displayId, new Uint8Array(image.resize({ width: DELTA_PROBE_WIDTH }).toBitmap()))
        if (!verdict.send) {
          // Throttled skip log: every 5th consecutive skip — the 10-tick heartbeat resets the streak, so a
          // once-per-10 line would never fire; 5 yields at most one line per heartbeat interval (~25s).
          if (verdict.skipStreak % 5 === 0)
            console.log(`[shell] screen Δ-gate: display ${displayId} static for ${verdict.skipStreak} ticks (deltaScore ${verdict.deltaScore.toFixed(4)})`)
          return { outcome: 'delta-skipped' }
        }
        try {
          const size = image.getSize()
          const jpeg = image.toJPEG(70) // ~0.7 quality — still frames, not video
          // Copy into a fresh, exactly-sized ArrayBuffer (a Node Buffer's .buffer is a shared pool typed
          // ArrayBuffer|SharedArrayBuffer; RawSegment.bytes is a plain ArrayBuffer).
          const bytes = new Uint8Array(jpeg).buffer
          const accepted = await controller.onSegment(
            {
              source: 'screen',
              bytes,
              mimeType: 'image/jpeg',
              capturedAt: occurredAt,
              screenMeta: { displayId, width: size.width, height: size.height, scale, deltaScore: verdict.deltaScore },
            },
            context,
          )
          if (accepted) return { outcome: 'accepted', capture: accepted }
          // assess() committed this probe as the new baseline. If no pixels became durable, forget it so
          // the next tick retries instead of calling the missing frame "unchanged" until the heartbeat.
          frameDeltaGate.reset()
          return undefined
        } catch (error) {
          frameDeltaGate.reset()
          throw error
        }
      },
      // Metadata-only and intentionally ephemeral. EngineLink authenticates + handles one token refresh,
      // but does not spool this report; runScreenCaptureAttempt also contains any reporting failure.
      observe: async (observation) => engineLink?.observeScreen(observation),
      log: clientLog,
    })
  } finally {
    screenAttemptRunning = false
  }
}

/**
 * control.start for screen: drive the cadence loop via startScreenCadence (grabs a frame now, then on the
 * config-resolved cfg.screenIntervalMs — clamped into the 3–6s band by resolveScreenIntervalMs). The loop
 * mechanics live in capture/screen-source.ts so the "screen source honours the configured cadence"
 * behaviour is unit-tested with a fake timer (issue #4).
 */
const startScreenLoop = (): void => {
  if (screenCadence) return
  frameDeltaGate.reset() // fresh session ⇒ no prior probe ⇒ the first frame always sends (#5)
  screenCadence = startScreenCadence({ intervalMs: cfg.screenIntervalMs, grab: () => void captureScreenFrame() })
}

/**
 * control.stop for screen: stop the cadence and confirm the stop on the next tick. Unlike the audio
 * renderer there is no async final-segment flush (each grab is a self-contained frame), but the controller
 * still needs onCaptureStopped to complete its stopping→idle handshake (and honor any queued restart), so
 * we defer it via setImmediate to mirror the audio path's asynchronous `stopped` signal.
 */
const stopScreenLoop = (): void => {
  screenCadence?.stop()
  screenCadence = undefined
  setImmediate(() => void screenController?.onCaptureStopped())
}

/** The honest outcome of an Ask-face frame request — a frame, or the human reason there is none. */
type AskFrameOutcome = { ok: true; frame: { contentType: 'image/jpeg'; data: string } } | { ok: false; reason: string }

/**
 * ONE still frame for an explicit chat send (the Ask face: screenshot-on-every-send). This is NOT the
 * ambient cadence loop: no Δ-gate (the user asked about THIS moment — an unchanged screen is still the
 * answer), no capture controller, no session; exactly one grab per invoke, and the invoke only ever
 * arrives from the send path. CONSENT is enforced here, in main: the screen sense must be ENABLED
 * (cfg.screenEnabled, opt-in default OFF) and the OS grant not refused — otherwise an honest { ok:false,
 * reason } comes back and the send proceeds WITHOUT a frame (never silent, never blocking). Mirroring the
 * cadence path's TCC posture, 'not-determined' proceeds (the first grab is what surfaces the macOS
 * prompt) and an empty image reads as "no frame yet".
 */
const captureAskFrame = async (): Promise<AskFrameOutcome> => {
  if (!cfg.screenEnabled) return { ok: false, reason: 'screen capture is off (enable screenEnabled in client config)' }
  if (!(await requestScreenPermission())) return { ok: false, reason: 'screen recording is not permitted — grant it in System Settings, then relaunch' }
  try {
    const grabbed = await grabPrimaryDisplayImage()
    if (!grabbed) return { ok: false, reason: 'no screen frame available (Screen-Recording grant still pending?)' }
    return { ok: true, frame: { contentType: 'image/jpeg', data: grabbed.image.toJPEG(70).toString('base64') } }
  } catch (err) {
    return { ok: false, reason: `screen capture failed: ${err instanceof Error ? err.message : String(err)}` }
  }
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
  engineLink = new EngineLink({
    baseUrl: cfg.engineUrl,
    spoolDir: path.join(app.getPath('userData'), 'capture-spool'),
    credentials: engineCredentials,
  })
  engineLink.startFlushLoop() // drain spooled chunks once the engine is reachable again (offline-safe)
  const link = engineLink
  // The readiness/ack handshake (issue #41): every audio start flows through here, gated on the hidden
  // renderer having pinged `capture:loaded` and acked the start — no more fire-and-forget send that
  // could race the renderer's listener registration and vanish. A start unacked after retries becomes a
  // VISIBLE tray fault + resets the controller (onCaptureFault) instead of a silent forever-`starting`.
  const dispatcher = new CaptureDispatcher({
    // A `start` carries the config-resolved segment cadence (CaptureStartOptions, #57) so the renderer
    // records at cfg.segmentMs rather than a hardcoded default; `stop` needs no payload. The value is
    // constant, so every retry resends the same options. This is the one seam that knows both the
    // channel constants and the config — the dispatcher's ack/retry state machine stays payload-agnostic.
    send: (channel: DispatchChannel, source: CaptureSourceKind) =>
      channel === 'start'
        ? captureWindow?.webContents.send(CAPTURE_CHANNELS.start, source, {
            segmentMs: cfg.segmentMs,
            // Chunk strategy + vad knobs (#95) — the renderer cuts at pauses under `vad` (the default) so a
            // cut never splits a word. Constant per run, so every ack/retry resends the same options.
            chunkStrategy: cfg.chunkStrategy,
            vadSilenceHoldMs: cfg.vadSilenceHoldMs,
            vadMinSegmentMs: cfg.vadMinSegmentMs,
            vadMaxSegmentMs: cfg.vadMaxSegmentMs,
            vadSilencePeak: cfg.vadSilencePeak,
            // #142: how to open the system-audio stream (loopback CoreAudio-Tap vs BlackHole device). The
            // renderer applies it only to the system-audio source; mic ignores it. Constant per run.
            systemAudioMethod: cfg.systemAudioMethod,
          })
        : captureWindow?.webContents.send(CAPTURE_CHANNELS.stop, source),
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
    `[shell] mic capture ${cfg.micEnabled ? 'enabled' : 'disabled by config'} · system-audio ${cfg.systemAudioEnabled ? 'enabled' : 'disabled by config'} · screen ${cfg.screenEnabled ? `enabled (every ${cfg.screenIntervalMs}ms, Δ-gate ${cfg.screenDeltaThreshold > 0 ? `≥${cfg.screenDeltaThreshold}` : 'off'})` : 'disabled by config (opt-in)'} · audio segments every ${cfg.segmentMs}ms (all follow the session lifecycle)`,
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
  void engineCredentials.credentialFor(cfg.engineUrl, { refresh: true }).then(
    (credential) => {
      if (!credential) {
        setTimeout(connectEvents, 1500)
        return
      }
      const wsUrl = `${cfg.engineUrl.replace(/^http/, 'ws')}/events`
      const socket = new WebSocket(wsUrl, engineWebSocketProtocols(credential))
      socket.addEventListener('message', (event) => {
        try {
          const parsed = JSON.parse(String((event as { data: unknown }).data)) as { name?: unknown; payload?: unknown }
          if (typeof parsed.name !== 'string') return
          if (liveState.applyEvent({ name: parsed.name, payload: parsed.payload })) refreshTray()
          // A surface was created/renamed/edited (PUT /layouts/surfaces/:id) — refresh the Apps folder list
          // so a new mini app appears (or a rename shows) without a restart (#98).
          if (parsed.name === 'surface.updated') {
            void refreshSurfaces()
            // A face's label is the mapped surface's name, so a rename should refresh the bundle view too.
            void refreshBundles()
          }
          // The live fabric changed (activate / PUT /fabric / active-profile edit) — recompute whether
          // the "Set up models…" nudge should be prominent, without a refetch (the event carries the map).
          if (parsed.name === 'fabric.changed' && parsed.payload) {
            needsSetup = needsModelSetup(parsed.payload as Fabric)
            refreshTray()
            // The fabric's slots drive the engine-side sense gates (an stt/ocr endpoint added or removed) —
            // re-evaluate so the capture readout's blocking gate stays accurate (issue #7).
            void refreshSenses()
          }
          // The route.detect flag was flipped (PUT /flags/route.detect) — start/stop focus watching live,
          // without a refetch (the event carries the Flag; its `default` is the effective value).
          if (parsed.name === 'flag.changed' && parsed.payload) {
            const flag = parsed.payload as Flag
            if (flag.key === ROUTE_DETECT_FLAG) applyDetectFlag(flag.default)
            // A processing flag flipped (distill.enabled/transcribe, screen.ocr) — the engine-side sense gates
            // may have opened/closed, so refresh the capture readout (issue #7).
            void refreshSenses()
          }
        } catch {
          /* ignore malformed frames */
        }
      })
      socket.addEventListener('close', () => setTimeout(connectEvents, 1500)) // reconnect reloads auth + re-seeds below
      socket.addEventListener('open', () => void seedSessionState())
    },
    () => setTimeout(connectEvents, 1500),
  )
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
    void openEngineSettings('first-run')
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
    // A reachable engine — read its /health identity, then ASSESS it against ours before trusting it (S6).
    // Silently adopting whatever answers is how a stale launchd/dev engine got used unnoticed. On a
    // version/build mismatch we REFUSE by default (no seed, no sessions through it) and surface a blocking
    // banner; a dev opts back in with OPENINFO_ALLOW_ENGINE_SKEW. Best-effort — an engine that reports no
    // version reads as "predates version reporting" and is treated as a mismatch (it is an old build).
    engineHealth = await fetchEngineHealth(cfg.engineUrl)
    const allowSkew = parseAllowSkew(process.env['OPENINFO_ALLOW_ENGINE_SKEW'])
    const verdict = assessEngineSkew({
      appVersion: app.getVersion(),
      ...(appBuild !== undefined ? { appBuild } : {}),
      ...(engineHealth.version !== undefined ? { engineVersion: engineHealth.version } : {}),
      ...(engineHealth.build !== undefined ? { engineBuild: engineHealth.build } : {}),
      allowSkew,
    })
    console.log(`[shell] adopted engine version: ${engineHealth.version ?? 'unknown (predates the /health version field)'}`)
    if (verdict.refused) {
      skewRefusal = verdict.reason
      console.error(`[shell] REFUSING to adopt a mismatched engine: ${verdict.reason} — set OPENINFO_ALLOW_ENGINE_SKEW=1 to adopt anyway`)
      clientLog?.(`[shell] engine skew refused: ${verdict.reason}`)
      openSystemWindow() // auto-open the System face so the mismatch is unmissable, with the fix in view
    } else if (verdict.skewed) {
      console.warn(`[shell] adopting a MISMATCHED engine because OPENINFO_ALLOW_ENGINE_SKEW is set: ${verdict.reason}`)
    }
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
      // Forward this app's build stamp as OPENINFO_BUILD (S6) so the bundled engine we spawn echoes the SAME
      // sha on /health — a packaged app inherits no env, so without this the engine's build reads empty and
      // the System face / tray couldn't prove the two halves are the one build. Omitted in a dev run (no stamp).
      env: { ...process.env, OPENINFO_PORT: String(port), ...(appBuild !== undefined ? { OPENINFO_BUILD: appBuild } : {}) },
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

/**
 * Refresh the engine-side per-sense gate verdicts (GET /senses, issue #7) and repaint the tray. The
 * verdicts change when a flag flips or the fabric changes (a slot gains/loses an endpoint), so this runs
 * on the WS flag.changed / fabric.changed events as well as at seed. Best-effort — an unreachable or old
 * engine leaves `senseGates` as-is (the tray falls back to the client-side gates it always knows).
 */
const refreshSenses = async (): Promise<void> => {
  try {
    senseGates = await session.senses()
    refreshTray()
  } catch (err) {
    console.error('[shell] could not read /senses for the capture readout:', err)
  }
}

/**
 * Fetch the app surfaces the engine serves (GET /layouts/surfaces) for the tray Apps folder (#98). Runs
 * at seed and on the WS `surface.updated` event (a new/renamed/cloned surface should appear in the
 * folder). Best-effort: an unreachable/old engine leaves the last-known list, so the folder simply isn't
 * shown until we learn one — no engine contract change (this route already exists).
 */
const refreshSurfaces = async (): Promise<void> => {
  try {
    const res = await shellEngineFetch('/layouts/surfaces')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const list = (await res.json()) as Array<{ id?: unknown; name?: unknown }>
    appSurfaces = list
      .filter((s): s is { id: string; name: string } => typeof s.id === 'string' && typeof s.name === 'string')
      .map((s) => ({ id: s.id, name: s.name }))
    refreshTray()
  } catch (err) {
    console.error('[shell] could not read /layouts/surfaces for the Apps folder:', err)
  }
}

/**
 * Fetch the app bundles the engine serves (GET /bundles) for the tray Apps folder (bundle-as-runtime-
 * object). Each bundle is ONE app whose faces open the mapped surfaces. Read-only consumption: the shell
 * never edits a bundle. Best-effort — an old/unreachable engine that has no /bundles route leaves the last-
 * known list (empty ⇒ the folder falls back to the flat #98 surface listing), never crashing the tray. We
 * tolerate the payload defensively (id/name/faces), so a forward-compatible bundle field never breaks us.
 */
const refreshBundles = async (): Promise<void> => {
  try {
    const res = await shellEngineFetch('/bundles')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const list = (await res.json()) as Array<{ id?: unknown; name?: unknown; faces?: unknown }>
    appBundles = list
      .filter((b): b is { id: string; name: string; faces: unknown[] } => typeof b.id === 'string' && typeof b.name === 'string' && Array.isArray(b.faces))
      .map((b) => ({
        id: b.id,
        name: b.name,
        faces: b.faces
          .filter((f): f is { kind: 'hud' | 'chat' | 'support'; surfaceRef: string; title?: string } => {
            const face = f as { kind?: unknown; surfaceRef?: unknown }
            return (face.kind === 'hud' || face.kind === 'chat' || face.kind === 'support') && typeof face.surfaceRef === 'string'
          })
          .map((f) => ({ kind: f.kind, surfaceRef: f.surfaceRef, ...(typeof f.title === 'string' ? { title: f.title } : {}) })),
      }))
    refreshTray()
  } catch (err) {
    console.error('[shell] could not read /bundles for the Apps folder:', err)
  }
}

const seedSessionState = async (): Promise<void> => {
  // A refused (skewed) engine is NOT ours to drive (S6): skip the whole seed so Start/End stays disabled
  // and no session, capture, or fabric state is read from the mismatched engine. The tray leads with the
  // refusal; the System window carries the fix. This is the substantive half of "refuse to adopt".
  if (skewRefusal !== undefined) {
    engineTried = true
    connected = false
    refreshTray()
    return
  }
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
  // Seed the per-sense gate verdicts (issue #7) so the capture-status readout names the engine-side
  // blocking gate too. Best-effort: an old/unreachable engine just leaves the engine-side gates absent.
  await refreshSenses()
  // Seed the Apps folder's surface list (#98) + bundle list (bundle-as-runtime-object) — best-effort, so
  // the folder appears once we reach the engine. Bundles render as one app each; unclaimed surfaces demote.
  await refreshSurfaces()
  await refreshBundles()
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
  // Read this app's build stamp (S6) — the git short sha package.mjs wrote into the app resources. Undefined
  // in a dev run. Used to forward OPENINFO_BUILD to a spawned engine, to assess build-level skew, and to show
  // the build on the System face. Read before ensureEngine (which needs it for both the spawn env and skew).
  appBuild = readBuildStamp(process.resourcesPath)
  clientLog(`[shell] launch — engine ${cfg.engineUrl}, workspace ${cfg.workspace}, build ${appBuild ?? 'dev (unstamped)'}, capture opens STOPPED until you start a session`)
  // Grant only the media (mic) permission at the Chromium layer for our own windows; deny everything
  // else. The OS-level (TCC) gate is separate — requestMicPermission handles that before capture.
  electronSession.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'media'))
  // Electron keeps only the last listener for each webRequest event. Install the ONE centralized engine
  // auth listener before creating any HUD windows; individual built-in webContents are allowlisted at birth.
  rendererEngineAuth.install(electronSession.defaultSession.webRequest as unknown as ElectronWebRequestLike)
  liveState.onChange((live) => {
    refreshTray()
    applyCaptureLifecycle(live)
  })
  // Drag + resize IPC are routed by `event.sender` to the exact window that sent them (#19: N windows,
  // one shell). Custom cursor-follow drag is for FRAMELESS HUD-style windows only — a framed app window
  // drags via its native titlebar, so its drag IPC is ignored here.
  ipcMain.on('hud:drag-start', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window && windowMeta.get(window)?.chrome === 'hud') startWindowDrag(window)
  })
  ipcMain.on('hud:drag-end', () => endWindowDrag())
  ipcMain.on('hud:resize', (event, height: number) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window) resizeWindowToContent(window, height)
  })
  // #134: an attached-panel surface reports its collapsed/expanded content extent along its edge; set it
  // on the exact window that sent it (same event.sender routing as drag/resize).
  ipcMain.on('hud:panel-size', (event, size: { width?: number; height?: number }) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window) resizePanelWindow(window, size)
  })
  // The Ask face capture bridge: one still frame per EXPLICIT chat send (preload.cts openinfoScreen).
  // The consent gate (screen sense enabled + OS grant) lives in captureAskFrame — a refusal answers an
  // honest { ok:false, reason } the send path paints, never a silent null and never a blocked send.
  ipcMain.handle('hud:capture-frame', () => captureAskFrame())
  // The pill's settings-on-hover bridge (the-pill): open the EXISTING settings surface — the SAME path the
  // tray's open-setup command opens (GET /settings in the default browser). Not a new settings UI; the pill
  // just reaches the one that already ships. Fire-and-forget; a failed open is logged, never a silent hang.
  ipcMain.on('hud:open-settings', () => {
    void openEngineSettings('pill')
  })
  // Load the Apps-folder state (favorites + open set + per-app positions) before creating windows so a
  // reopened app restores its saved position (#19/#20/#98). Best-effort — a missing file reads as empty.
  appState = readAppState(app.getPath('userData'))
  createHudWindow()
  reopenPersistedApps() // reopen the app windows that were open at last quit (the default HUD always opens)
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
app.on('before-quit', () => {
  shuttingDown = true // freeze the persisted open-set: the app-window teardown below must not clear it (#19)
})
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
