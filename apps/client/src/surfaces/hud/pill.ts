/**
 * The PILL height authority + view-state machine (renderer side) — the three-state extension of the
 * two-state PanelController (#134). The pill is the MVP Standard App window: a compact header RECTANGLE
 * (Listen / Ask / Show-Hide / settings) with a DOCKED PANEL beneath it. Its window has THREE heights, not
 * two:
 *   - BAR    — Show-Hide off: just the header rectangle (the "dramatically shortened default HUD").
 *   - LISTEN — the Listen glance panel (live-transcript + distilled glance blocks).
 *   - ASK    — the Ask chat panel, ~3× the bar (the recorded chat-beneath-HUD geometry).
 *
 * Split like panel.ts / auto-resize.ts: the height MATH is a PURE function and the state machine drives a
 * tiny injected bridge (the same `hud:panel-size` seam PanelController uses), so the whole thing is asserted
 * headless under node:test and the electron shell just applies the reported content size. A pill surface
 * installs THIS as its ONE height authority instead of PanelController/auto-resize (dev-entry, by surface
 * id) — so nothing fights over the window height (S1).
 *
 * Selecting a face (Listen/Ask) opens the panel to that face's extent; Show-Hide toggles the panel closed
 * to the bar and back, independently of which face is selected — exactly the glass pill's verbs.
 */

export type PillFace = 'listen' | 'ask'

/** The three window content-heights (px) the pill sizes to, along the below-edge HEIGHT axis. */
export interface PillExtents {
  bar: number
  listen: number
  ask: number
}

/**
 * The default LISTEN extent (px) — the intermediate height between the bar and the tall Ask panel. It is a
 * CLIENT layout constant (the surface `panel` contract carries only the two extents the shell's panel
 * machinery needs — collapsed=bar, expanded=ask); the pill adds this third one. Disclosed.
 */
export const PILL_LISTEN_EXTENT = 300

/** Derive the pill's three extents from a surface's declared below-panel (collapsed=bar, expanded=ask). */
export const pillExtentsFromPanel = (panel: { collapsed: number; expanded: number }, listen = PILL_LISTEN_EXTENT): PillExtents => ({
  bar: panel.collapsed,
  ask: panel.expanded,
  // The listen extent sits between bar and ask; never taller than the ask panel, never shorter than the bar.
  listen: Math.max(panel.collapsed, Math.min(listen, panel.expanded)),
})

/** PURE: the window content-height for a (face, open) state. Closed ⇒ the bar; open ⇒ the face's extent. */
export const pillHeight = (face: PillFace, open: boolean, ext: PillExtents): number =>
  !open ? ext.bar : face === 'ask' ? ext.ask : ext.listen

/** The bridge the controller drives — `apply` reports the target content height (electron: setContentSize). */
export interface PillBridge {
  apply(size: { height: number }): void
}

export interface PillState {
  face: PillFace
  open: boolean
  /** true once the bundle's chat face has resolved to a surface — gates the Ask affordance honestly. */
  askAvailable: boolean
}

export interface PillOptions {
  extents: PillExtents
  bridge: PillBridge
  /** Called after any state change so the renderer re-paints (dev-entry routes this to Hud.rerender). */
  onChange: () => void
  startOpen?: boolean
  startFace?: PillFace
}

/**
 * The pill's view-state machine + height authority. `face`/`open` are client-local (session-ephemeral,
 * like the #96 system-mute and #75 clarify state) — no network, no persistence. Every state change applies
 * the new window height over the bridge AND fires `onChange` so the renderer repaints the header + panel.
 */
export class PillController {
  private face: PillFace
  private open: boolean
  private askAvailable = false
  private readonly ext: PillExtents
  private readonly bridge: PillBridge
  private readonly onChange: () => void

  constructor(options: PillOptions) {
    this.ext = options.extents
    this.bridge = options.bridge
    this.onChange = options.onChange
    this.open = options.startOpen ?? true
    this.face = options.startFace ?? 'listen'
  }

  /** Apply the initial extent (the shell sizes the window to the pill's opening state). */
  start(): void {
    this.applyGeometry()
  }

  state(): PillState {
    return { face: this.face, open: this.open, askAvailable: this.askAvailable }
  }

  /** Select a face (Listen/Ask). Selecting a face reveals the panel (open) — the glass pill's mode verbs. */
  setFace(face: PillFace): void {
    // Ask is honestly inert until its bundle face resolves — selecting it is a no-op (the button is also
    // rendered disabled in that state, so this is belt-and-suspenders, never a silent surprise).
    if (face === 'ask' && !this.askAvailable) return
    this.face = face
    this.open = true
    this.applyGeometry()
    this.onChange()
  }

  /** Show-Hide: collapse the docked panel to the bar (and back), independent of the selected face. */
  toggle(): void {
    this.open = !this.open
    this.applyGeometry()
    this.onChange()
  }

  /** Mark the Ask face available once the bundle's chat face resolved (or unavailable if it did not). */
  setAskAvailable(available: boolean): void {
    if (this.askAvailable === available) return
    this.askAvailable = available
    this.onChange()
  }

  private applyGeometry(): void {
    this.bridge.apply({ height: pillHeight(this.face, this.open, this.ext) })
  }
}
