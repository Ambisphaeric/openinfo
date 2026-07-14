/**
 * The production surface-window CONSTRUCTOR (#194) — the exact body the shell's window factory runs,
 * extracted so the driven pill e2e can build its windows through the SAME function production uses
 * instead of mirroring it. Everything window-SHAPED lives here, unconditional: the window contract
 * assertion, the spec resolution, the self-identifying title stamp, the preload, the method-only
 * hardening, the renderer observability handlers, and the hud.html load — so a regression inside the
 * constructor's body fails the driven proof, not just the shell.
 *
 * The caller-bound seams (`SurfaceWindowEnv`) are everything that reads shell STATE rather than shaping
 * the window: shell.ts supplies all of them (engine auth pinning, per-window meta, the position stores);
 * the e2e supplies only its fake-engine URL and leaves the hooks absent (see pill-e2e.mjs's header for
 * why each one stays a harness mirror).
 *
 * Main-process-only: this module imports electron (BrowserWindow), like shell.ts, and headless tests
 * never import it — the pure spec/contract logic stays in window-options.ts, asserted headless.
 */
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { BrowserWindow } from 'electron'
import { surfaceWindowSpec, windowTitleFor, assertWindowContract, type HudWindowSpec, type WindowChrome } from './window-options.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** The ONE shared HUD document every surface window loads (dist/main → apps/client/hud.html). */
export const HUD_HTML = path.join(__dirname, '..', '..', 'hud.html')
/** The compiled preload every surface window gets (.cts source → CommonJS — see preload.cts). */
export const PRELOAD_JS = path.join(__dirname, 'preload.cjs')

/** The per-window binding the shell keeps: which surface, which chrome, whether it is the singular HUD. */
export interface SurfaceWindowMeta {
  surfaceId: string
  chrome: WindowChrome
  isDefaultHud: boolean
}

/** How a surface window is born: its chrome, whether it is the default HUD, whether it opens visible. */
export interface SurfaceWindowOpts {
  chrome: WindowChrome
  isDefaultHud: boolean
  startVisible: boolean
}

/**
 * The caller-bound seams of the constructor. Production (shell.ts) supplies every hook; the driven e2e
 * supplies only `engineUrl` (its fake engine) — auth it mirrors at the defaultSession webRequest seam,
 * and the meta/position hooks are per-user shell state a throwaway harness must not read or write.
 */
export interface SurfaceWindowEnv {
  /** The engine base URL passed to the renderer (the `engine` query param on hud.html). */
  engineUrl: string
  /** ShellConfig.hudOutline — `outline=1` draws renderer debug bounds. */
  hudOutline?: boolean
  /** Allowlist this window's webContents for engine credentials (production: pinTrustedSurface). */
  pinAuth?: (window: BrowserWindow) => void
  /** Record the shell's per-window meta (drag/resize IPC routing + the position stores read it). */
  registerMeta?: (window: BrowserWindow, meta: SurfaceWindowMeta) => void
  /** Place the window where it was last left (production: the per-window position stores). */
  restorePosition?: (window: BrowserWindow) => void
  /** Persist an OS-level move (production: the debounced position saver). */
  onMoved?: (window: BrowserWindow) => void
}

/**
 * Construct ONE surface window (#19) — the generalized window constructor the default HUD and every
 * Apps-folder mini app share. A window is BORN bound to its surface (the id is a frozen URL query param —
 * see hud.ts); multi-window is a REGISTRY of such windows, never a re-binding of one. `chrome` decides the
 * shell: HUD chrome is the inherited Glass signature (frameless, transparent, always-on-top,
 * content-protected, content-sized, drag-follow); `app` chrome is a normal framed app window (a
 * diagnostics app beside the HUD).
 */
export const constructSurfaceWindow = (surfaceId: string, opts: SurfaceWindowOpts, env: SurfaceWindowEnv): BrowserWindow => {
  // The window CONTRACT (policy item 3), enforced HERE in the one constructor: every surface window either
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
  // receive engine credentials, and only after headers leave renderer JS. Revoked on destruction (shell.ts).
  env.pinAuth?.(window)
  env.registerMeta?.(window, { surfaceId, chrome: opts.chrome, isDefaultHud: opts.isDefaultHud })

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

  env.restorePosition?.(window)
  // Pass the engine URL + the surface id so the renderer fetches + renders THIS surface's layout (the same
  // per-window binding the single HUD always had). `outline=1` (ShellConfig.hudOutline) draws debug bounds.
  void window.loadFile(HUD_HTML, {
    search: new URLSearchParams({
      engine: env.engineUrl,
      surface: surfaceId,
      ...(env.hudOutline ? { outline: '1' } : {}),
    }).toString(),
  })
  window.on('moved', () => env.onMoved?.(window)) // OS-level moves; the custom drag also persists on drag-end
  return window
}
