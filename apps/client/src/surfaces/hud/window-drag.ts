/**
 * Renderer-side wiring for dragging the HUD by its header strip. The window is frameless AND
 * `focusable: false`, so CSS `-webkit-app-region: drag` is inert on macOS (that region rides the AppKit
 * window-drag, which only engages for a focusable window). Instead: a mousedown on the `.hudtop` strip
 * tells the main process to start following the cursor (over the preload bridge), and any mouseup /
 * pointer-leave ends it. The actual moving happens in the main process (shell.ts) via the OS cursor —
 * see window-position.ts for why. This module is pure over an injected document + bridge so the
 * hit-testing (drag on the strip, NEVER on an action button inside it) is asserted headless.
 *
 * In a plain browser (dev-hud.html) there is no bridge, so dev-entry.ts simply doesn't install this —
 * the browser HUD is a normal scrollable page, unaffected.
 */

/** The tiny surface the preload exposes (contextBridge → window.openinfoDrag). Coordinate-free: the */
/** main process reads the live cursor itself, so the renderer only signals the drag's start and end. */
export interface DragBridge {
  start(): void
  end(): void
}

interface HitTarget {
  closest(selector: string): unknown
}
interface DragMouseEvent {
  target: HitTarget | null
  button?: number
}
interface DragDocument {
  addEventListener(type: 'mousedown' | 'mouseup' | 'mouseleave', handler: (event: DragMouseEvent) => void): void
}

/** Interactive descendants that must never begin a drag even though they live inside the grab strip. */
const INTERACTIVE = '[data-verb], .mini, button, a, input, textarea, select'

/**
 * Is this the grab strip and not something you'd click? True only when the target is within `.hudtop`
 * and NOT within an interactive control — so dragging the header never swallows a button press.
 */
export const isGrabTarget = (target: HitTarget | null): boolean =>
  target !== null && target.closest('.hudtop') !== null && target.closest(INTERACTIVE) === null

/**
 * Install the drag listeners on the document. Delegated (on the document, not the strip) so it survives
 * the HUD's innerHTML re-renders — the same reason mount.ts delegates its click handling. Primary
 * mouse button only; any release or the pointer leaving the window ends the drag (main's end is a no-op
 * when nothing is dragging, so an over-eager mouseup is harmless).
 */
export const installWindowDrag = (doc: DragDocument, bridge: DragBridge): void => {
  doc.addEventListener('mousedown', (event) => {
    if ((event.button ?? 0) !== 0) return
    if (isGrabTarget(event.target)) bridge.start()
  })
  const end = (): void => bridge.end()
  doc.addEventListener('mouseup', end)
  doc.addEventListener('mouseleave', end)
}
