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

/**
 * The HUD is CONTENT-sized: the renderer measures the painted panel and the shell sets the window's
 * content height to match (auto-resize.ts → hud:resize → shell.ts), so the transparent frame never
 * extends past the panel into a click-blocking dead zone. This is the floor the window opens at and
 * never shrinks below — sized to the empty-state bar (the Now line + section headers) so a quiet HUD
 * shows no dead zone and never clips its own bar. Tuned against the real rendered empty state, which
 * measures 152px (Now line + the two section headers) in the hud-bounds e2e — the floor sits just below
 * it so a normal empty HUD is content-sized exactly (never a floor-induced dead zone) while a degenerate
 * zero/torn-down measurement still yields a plausible bar. `resizable: false` is kept — setContentSize
 * still works programmatically (asserted by the e2e).
 */
export const HUD_MIN_HEIGHT = 144

export const hudWindowSpec = (opts: { startVisible?: boolean } = {}): HudWindowSpec => {
  const startVisible = opts.startVisible ?? false
  return {
    browserWindow: {
      width: PANEL_WIDTH + WINDOW_MARGIN * 2,
      height: HUD_MIN_HEIGHT,
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
