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

export const hudWindowSpec = (opts: { startVisible?: boolean; width?: number } = {}): HudWindowSpec => {
  const startVisible = opts.startVisible ?? false
  return {
    browserWindow: {
      width: opts.width ?? PANEL_WIDTH + WINDOW_MARGIN * 2,
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

/**
 * Per-surface window CHROME (#20 + the mini-apps arc). The shipped HUD surfaces render as the inherited
 * Glass shell — frameless, transparent, always-on-top, content-protected, content-sized. Any OTHER
 * surface opened from the Apps folder is a NORMAL app window: framed, opaque, resizable, focusable, in
 * the app switcher, and NOT content-protected (a diagnostics app you WANT visible and in screenshots,
 * running beside the real HUD). Disclosed default: an unknown surface id ⇒ `'app'` chrome.
 */
export type WindowChrome = 'hud' | 'app'

/** A surface's declared window options — its chrome and an optional width override (default preserved, #20). */
export interface SurfaceWindowConfig {
  chrome: WindowChrome
  /** Outer window width in px; omitted ⇒ the chrome's default (HUD panel width, or the app default). */
  width?: number
}

/**
 * The client-side per-surface window config map (#20). Client-declared (not on the surface document) for
 * v0 — disclosed; moving these onto the surface doc is a later choice. Only the shipped HUD surfaces are
 * listed; everything else falls through to `'app'` chrome via `configForSurface`.
 */
export const SURFACE_WINDOW_CONFIG: Record<string, SurfaceWindowConfig> = {
  'surf-openinfo-hud': { chrome: 'hud' },
  'surf-glass-minimal': { chrome: 'hud', width: 520 },
  // The #100 fields app: a companion panel that lives BESIDE the HUD. It carries the same sensitive
  // meeting content the HUD does (the live fields, the raw distillate stream), so it takes the inherited
  // Glass chrome — frameless, transparent, always-on-top, content-PROTECTED (invisible to screen-share),
  // content-sized, a glance that never steals focus — deliberately NOT the framed `app` chrome (that is
  // for a diagnostics app you WANT in screenshots). Narrower than the HUD (480 vs the 660+margin panel) so
  // the two sit side-by-side without overlap. Glass chrome also means it renders through the SAME HUD
  // controller (hud.ts), so it inherits the event-fed live-transcript strip (#58) for free.
  'surf-openinfo-fields': { chrome: 'hud', width: 480 },
  // The #101 diagnostics app: deliberately the FRAMED `app` chrome, not glass — a debugger is a tool the
  // user wants visible in screenshots/screen-share (no content protection), resizable, and focusable while
  // they poke at the pipeline; it must NOT float always-on-top over the app it is diagnosing.
  'surf-openinfo-diagnostics': { chrome: 'app', width: 560 },
  // The #133 meeting note-taker: the mainstream look-and-speed EXEMPLAR. Deliberately the FRAMED `app`
  // chrome — a full three-zone workspace app (left rail · center canvas · right enrichments) you WORK in
  // and can screenshot for the owner's look-and-speed review, resizable, focusable, in the app switcher,
  // NOT the always-on-top glass HUD. Wide enough to seat the three columns side-by-side at first render.
  'surf-openinfo-notetaker': { chrome: 'app', width: 960 },
  // The #134 attached-panel shells. Both take the inherited Glass chrome — frameless, transparent,
  // content-PROTECTED (they carry the same sensitive session content the HUD does), always-on-top — so
  // they float beside/beneath the HUD. Their COLLAPSED/EXPANDED extent is owned by the surface's `panel`
  // block and applied over the hud:panel-size bridge (the renderer installs the PanelController instead of
  // auto-resize for these), NOT the content-sizer. The chat is the HUD's own width so it sits flush
  // beneath it; the sidebar's width is driven by its panel (collapsed 0 → expanded 320).
  'surf-openinfo-chat': { chrome: 'hud' },
  'surf-openinfo-sidebar': { chrome: 'hud', width: 320 },
}

/** The window config for a surface id — its explicit entry, else the disclosed `'app'` default. */
export const configForSurface = (surfaceId: string): SurfaceWindowConfig =>
  SURFACE_WINDOW_CONFIG[surfaceId] ?? { chrome: 'app' }

/** A framed app window's default outer size — a sane starting box for a normal-chrome mini app. */
export const APP_WINDOW_DEFAULT_WIDTH = 520
export const APP_WINDOW_DEFAULT_HEIGHT = 560

/**
 * The window spec for a NORMAL-chrome mini app (a diagnostics-style surface, not the HUD). Same structural
 * shape as hudWindowSpec so the shell spreads it into `new BrowserWindow(...)` identically, but framed,
 * opaque, resizable, focusable, in the app switcher, and NOT content-protected. Its hardening is all
 * benign (no content-protection, no always-on-top, no all-workspaces) so the shell can apply the same
 * post-create calls unconditionally — see shell.ts (setAlwaysOnTop is skipped when `alwaysOnTop` is false).
 */
export const appWindowSpec = (opts: { width?: number; startVisible?: boolean } = {}): HudWindowSpec => {
  const startVisible = opts.startVisible ?? false
  return {
    browserWindow: {
      width: opts.width ?? APP_WINDOW_DEFAULT_WIDTH,
      height: APP_WINDOW_DEFAULT_HEIGHT,
      frame: true,
      transparent: false,
      hasShadow: true,
      resizable: true,
      maximizable: true,
      minimizable: true,
      fullscreenable: true,
      skipTaskbar: false,
      alwaysOnTop: false,
      focusable: true,
      show: startVisible,
      title: 'openinfo app',
      backgroundColor: '#101014',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    },
    hardening: {
      contentProtection: false,
      alwaysOnTopLevel: 'floating',
      visibleOnAllWorkspaces: false,
      visibleOnFullScreen: false,
    },
    startVisible,
  }
}
