import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { app, BrowserWindow, Menu, Tray, globalShortcut, nativeImage, type MenuItemConstructorOptions } from 'electron'
import { resolveShellConfig, type ShellConfig } from './config.js'
import { hudWindowSpec } from './window-options.js'
import { buildTrayMenu, trayTooltip, type TrayState } from './tray-menu.js'
import { SHORTCUTS, type ShellCommand } from './shortcuts.js'
import { EngineSessionClient, SessionLiveState } from './engine-session.js'
import { TRAY_ICON_TEMPLATE_1X, TRAY_ICON_TEMPLATE_2X, trayIconBuffer } from './tray-icon.js'

/**
 * The Electron shell — the ONLY file that imports electron, and the one tests never import (all the
 * logic it wires lives in the pure sibling modules, asserted headless). It hosts the existing
 * document-driven HUD in a frameless, always-on-top, content-protected window (the inherited Glass
 * signature), a menu-bar tray whose Start/End Session toggles the engine and reflects live state,
 * and the ⌘\ global shortcut that hides/shows the window like Glass.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HUD_HTML = path.join(__dirname, '..', '..', 'hud.html')

const cfg: ShellConfig = resolveShellConfig()
const session = new EngineSessionClient(cfg.engineUrl)
const liveState = new SessionLiveState(cfg.workspace)

let hudWindow: BrowserWindow | undefined
let tray: Tray | undefined
let connected = false

const trayState = (): TrayState => ({
  visible: hudWindow?.isVisible() ?? false,
  sessionLive: liveState.live,
  connected,
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
    case 'quit':
      app.quit()
  }
}

const createHudWindow = (): void => {
  const spec = hudWindowSpec()
  hudWindow = new BrowserWindow(spec.browserWindow)

  // Method-only hardening (no constructor-option equivalent):
  hudWindow.setContentProtection(spec.hardening.contentProtection)
  hudWindow.setAlwaysOnTop(true, spec.hardening.alwaysOnTopLevel)
  hudWindow.setVisibleOnAllWorkspaces(spec.hardening.visibleOnAllWorkspaces, {
    visibleOnFullScreen: spec.hardening.visibleOnFullScreen,
  })
  console.log(`[shell] HUD window created — content-protection: ${spec.hardening.contentProtection ? 'ON' : 'off'}`)

  void hudWindow.loadFile(HUD_HTML, { search: new URLSearchParams({ engine: cfg.engineUrl }).toString() })
  hudWindow.on('closed', () => (hudWindow = undefined))
}

const createTray = (): void => {
  const icon = nativeImage.createFromBuffer(trayIconBuffer(TRAY_ICON_TEMPLATE_1X))
  icon.addRepresentation({ scaleFactor: 2, buffer: trayIconBuffer(TRAY_ICON_TEMPLATE_2X) })
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  refreshTray()
}

/** Push live-session state from the engine WS (session.started/ended) — no polling; see engine-session.ts. */
const connectEvents = (): void => {
  const wsUrl = `${cfg.engineUrl.replace(/^http/, 'ws')}/events`
  const socket = new WebSocket(wsUrl)
  socket.addEventListener('message', (event) => {
    try {
      const parsed = JSON.parse(String((event as { data: unknown }).data)) as { name?: unknown; payload?: unknown }
      if (typeof parsed.name === 'string' && liveState.applyEvent({ name: parsed.name, payload: parsed.payload })) {
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
  refreshTray()
}

app.whenReady().then(() => {
  app.dock?.hide() // menu-bar-only agent (no dock icon), like a Glass-style companion
  liveState.onChange(() => refreshTray())
  createHudWindow()
  createTray()
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
app.on('will-quit', () => globalShortcut.unregisterAll())
