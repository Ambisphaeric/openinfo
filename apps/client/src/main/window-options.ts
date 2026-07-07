/**
 * The HUD window options builder — pure so the window's inherited-from-Glass signature (frameless,
 * always-on-top, content-protected, hidden-from-screenshare) is asserted in a headless test without
 * ever constructing a real BrowserWindow (CI has no display). The electron shell (shell.ts) spreads
 * `browserWindow` into `new BrowserWindow(...)` and applies the method-only hardening (`hardening`)
 * that has no constructor-option equivalent — `setContentProtection`, all-workspaces visibility.
 *
 * Chrome/size cues come from design/renderings/hud-v2.html: the `.hud` panel is 660px wide with a
 * translucent glass background, so the window is that width + transparent (the panel floats; the
 * window itself is invisible), frameless, and non-resizable.
 */

/** The subset of BrowserWindow constructor options the HUD uses (structural — no electron import). */
export interface HudBrowserWindowOptions {
  width: number
  height: number
  frame: boolean
  transparent: boolean
  hasShadow: boolean
  resizable: boolean
  maximizable: boolean
  minimizable: boolean
  fullscreenable: boolean
  skipTaskbar: boolean
  alwaysOnTop: boolean
  /** Do not steal focus when shown — the HUD is a heads-up glance, not a window you work in. */
  focusable: boolean
  show: boolean
  title: string
  backgroundColor: string
  webPreferences: {
    contextIsolation: boolean
    nodeIntegration: boolean
    /** Background throttling off so the live HUD keeps updating while hidden/behind. */
    backgroundThrottling: boolean
  }
}

/** Method-only window hardening (no constructor-option equivalent) — applied by the shell after create. */
export interface HudWindowHardening {
  /** win.setContentProtection(true) — NSWindowSharingNone on macOS: invisible to screen capture/share. */
  contentProtection: boolean
  /** win.setAlwaysOnTop(true, level) — float above normal windows. */
  alwaysOnTopLevel: 'screen-saver' | 'floating'
  /** win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen }) — present over other spaces/fullscreen apps. */
  visibleOnAllWorkspaces: boolean
  visibleOnFullScreen: boolean
}

export interface HudWindowSpec {
  browserWindow: HudBrowserWindowOptions
  hardening: HudWindowHardening
  /** Whether the window is shown at startup (Glass opens hidden; ⌘\ / the tray reveals it). */
  startVisible: boolean
}

/** Width of the `.hud` panel in hud-v2.html; +margin so the glass panel's shadow isn't clipped. */
const PANEL_WIDTH = 660
const WINDOW_MARGIN = 24

export const hudWindowSpec = (opts: { startVisible?: boolean } = {}): HudWindowSpec => {
  const startVisible = opts.startVisible ?? false
  return {
    browserWindow: {
      width: PANEL_WIDTH + WINDOW_MARGIN * 2,
      height: 720,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      show: startVisible,
      title: 'openinfo HUD',
      backgroundColor: '#00000000',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    },
    hardening: {
      contentProtection: true,
      alwaysOnTopLevel: 'floating',
      visibleOnAllWorkspaces: true,
      visibleOnFullScreen: true,
    },
    startVisible,
  }
}
