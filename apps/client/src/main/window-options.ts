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

export const hudWindowSpec = (opts: { startVisible?: boolean; width?: number; focusable?: boolean } = {}): HudWindowSpec => {
  const startVisible = opts.startVisible ?? false
  // `focusable` is a PER-SURFACE override, defaulting false (the inherited Glass glance never steals focus).
  // A HUD-chrome surface the user TYPES in (the chat's `input` block, #134) MUST be able to become the key
  // window — otherwise a `focusable:false` window can never accept keys, macOS NSBeeps every keystroke, and
  // typing is impossible (the chat-keyboard bug). Focusability is orthogonal to the rest of the Glass
  // signature (still frameless/transparent/content-protected/always-on-top), so we flip only this one flag.
  const focusable = opts.focusable ?? false
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
      focusable,
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
  /**
   * Whether this surface's window may become the key/focused window. Framed `app` chrome is always focusable
   * (a normal window); HUD chrome defaults to NON-focusable (a glance). A HUD-chrome surface the user TYPES
   * in must opt IN here (else macOS NSBeeps every keystroke into a window that can never accept it). Omitted
   * ⇒ the chrome default. Ignored for `app` chrome (already focusable).
   */
  focusable?: boolean
}

/**
 * The client-side per-surface window config map (#20). Client-declared (not on the surface document) for
 * v0 — disclosed; moving these onto the surface doc is a later choice. Only the shipped HUD surfaces are
 * listed; everything else falls through to `'app'` chrome via `configForSurface`.
 */
export const SURFACE_WINDOW_CONFIG: Record<string, SurfaceWindowConfig> = {
  'surf-openinfo-hud': { chrome: 'hud' },
  // THE PILL — the MVP Standard App glance face. Inherited Glass chrome (frameless, transparent,
  // content-PROTECTED, always-on-top — it carries live session content), and FOCUSABLE because its Ask
  // face embeds an `input` the user types in (else macOS NSBeeps every keystroke into a non-key window,
  // exactly as the chat panel opts in). Its bar/listen/ask heights are owned by the PillController over
  // the hud:panel-size bridge (dev-entry installs it instead of auto-resize for this surface).
  'surf-openinfo-pill': { chrome: 'hud', focusable: true },
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
  // The chat carries an `input` block the user TYPES in, so it opts INTO focusability (S1) — otherwise the
  // inherited Glass `focusable:false` makes the window unable to become key and every keystroke NSBeeps.
  'surf-openinfo-chat': { chrome: 'hud', focusable: true },
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

/**
 * The ONE place a surface's full window spec is resolved from its declared config — chrome, width override,
 * AND the per-surface focusability override (S1). Used by the shell's single window factory and by the
 * driven e2e so both build the EXACT same window a surface ships with (no drift between test and shell).
 */
export const surfaceWindowSpec = (surfaceId: string, opts: { startVisible?: boolean } = {}): HudWindowSpec => {
  const cfg = configForSurface(surfaceId)
  const startVisible = opts.startVisible ?? false
  const widthOpt = cfg.width !== undefined ? { width: cfg.width } : {}
  // Spread conditionally (exactOptionalPropertyTypes): an absent override must NOT be passed as `undefined`.
  const focusableOpt = cfg.focusable !== undefined ? { focusable: cfg.focusable } : {}
  return cfg.chrome === 'hud'
    ? hudWindowSpec({ startVisible, ...widthOpt, ...focusableOpt })
    : appWindowSpec({ startVisible, ...widthOpt })
}

/**
 * Per-surface human FACE names — what a window calls itself (S4). The window's live title is refined by the
 * renderer to the loaded surface document's `name`; this is the pre-load fallback the factory stamps so a
 * window is NEVER mislabeled "HUD" while it boots (the old bug: every framed titlebar read "openinfo — HUD"
 * because the shared hud.html <title> was the only title anything ever set). An unknown surface is humanized
 * from its id, so a new surface still self-identifies without a code change.
 */
const FACE_NAMES: Record<string, string> = {
  'surf-openinfo-hud': 'HUD',
  'surf-openinfo-pill': 'openinfo',
  'surf-glass-minimal': 'HUD',
  'surf-openinfo-fields': 'Fields',
  'surf-openinfo-diagnostics': 'Diagnostics',
  'surf-openinfo-notetaker': 'Meeting Notes',
  'surf-openinfo-chat': 'Chat',
  'surf-openinfo-sidebar': 'Sidebar',
}

/** Humanize an unknown surface id (`surf-openinfo-foo-bar` → `Foo Bar`) so it still names itself. */
const humanizeSurfaceId = (surfaceId: string): string =>
  surfaceId
    .replace(/^surf-/, '')
    .replace(/^openinfo-/, '')
    .split('-')
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'App'

/** The per-surface window title (chrome titlebar / app switcher). `openinfo — <Face>`. Pure + testable. */
export const windowTitleFor = (surfaceId: string): string => `openinfo — ${FACE_NAMES[surfaceId] ?? humanizeSurfaceId(surfaceId)}`

/**
 * The RESOLVED outer window width for a surface — its declared override, else the chrome default. Pure so
 * the window contract can reason about whether a fixed-size window provably fits its content.
 */
export const surfaceWindowWidth = (surfaceId: string): number => {
  const cfg = configForSurface(surfaceId)
  if (cfg.width !== undefined) return cfg.width
  return cfg.chrome === 'hud' ? PANEL_WIDTH + WINDOW_MARGIN * 2 : APP_WINDOW_DEFAULT_WIDTH
}

/**
 * The minimum outer width at which a fixed-size (non-resizable) HUD-chrome window PROVABLY fits its content
 * without the both-edges clip (the S5 mechanism makes `.hud` fluid up to its 660px cap, so any width at or
 * above this reflows cleanly; below it the block grids can no longer shrink and content is lost). A framed
 * `app` window is exempt — the user can always resize it to fit.
 */
export const MIN_HUD_FIT_WIDTH = 260

export interface WindowContract {
  surfaceId: string
  chrome: WindowChrome
  width: number
  /** The window can be resized by the user (framed app chrome) — so it fits by construction. */
  resizable: boolean
  /** A fixed-size window whose width is at or above the fit floor — provably fits without clipping. */
  fitsWidth: boolean
  /** The window's non-empty self-identifying title. */
  title: string
  /** The contract holds: the window resizes OR provably fits, AND it self-identifies. */
  ok: boolean
}

/**
 * The window contract (policy item 3), enforced in the ONE window factory: every surface window either
 * RESIZES (framed app chrome) or PROVABLY FITS its content at a fixed width (HUD chrome ≥ the fit floor,
 * given the fluid-panel S5 mechanism), AND it SELF-IDENTIFIES with a non-empty title. Pure so it is asserted
 * headless for every shipped surface; the factory calls `assertWindowContract` at create time so a future
 * surface added with a clipping width or no identity fails LOUDLY rather than shipping a broken window.
 */
export const windowContract = (surfaceId: string): WindowContract => {
  const cfg = configForSurface(surfaceId)
  const width = surfaceWindowWidth(surfaceId)
  const resizable = cfg.chrome === 'app'
  const fitsWidth = width >= MIN_HUD_FIT_WIDTH
  const title = windowTitleFor(surfaceId)
  return { surfaceId, chrome: cfg.chrome, width, resizable, fitsWidth, title, ok: (resizable || fitsWidth) && title.length > 0 }
}

/** Assert the window contract for a surface; throws with the offending detail if it does not hold. */
export const assertWindowContract = (surfaceId: string): WindowContract => {
  const contract = windowContract(surfaceId)
  if (!contract.ok) {
    throw new Error(
      `window contract violated for ${surfaceId}: a window must resize or provably fit (≥${MIN_HUD_FIT_WIDTH}px) and self-identify — ${JSON.stringify(contract)}`,
    )
  }
  return contract
}
