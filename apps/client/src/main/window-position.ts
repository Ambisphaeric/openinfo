/**
 * The HUD window's position logic — pure so the two things that are easy to get wrong (the drag math
 * and the "is the saved spot still real?" check) are asserted headless, without a BrowserWindow or a
 * display (CI has neither). The shell (shell.ts) owns the side effects: it reads the live cursor and
 * the current displays from electron and feeds them here, then applies the result with `setPosition`.
 *
 * Why a custom drag instead of CSS `-webkit-app-region: drag`: the HUD is `focusable: false` (a glance,
 * never a window you work in — a deliberate shell decision, see PHASE2-NOTES). On macOS the AppKit
 * window-drag that `-webkit-app-region: drag` rides on only engages for a focusable window, so the CSS
 * region is inert here. The shell instead tracks the OS cursor on drag and moves the window to follow
 * it — which needs the window to change origin by (cursor − grab-offset), the arithmetic below.
 */

/** A point in the global screen coordinate space (macOS: primary display's top-left is 0,0). */
export interface ScreenPoint {
  x: number
  y: number
}

/** A persisted window origin (top-left), the only geometry the HUD remembers (size is fixed). */
export interface WindowPosition {
  x: number
  y: number
}

/** A window's outer size — width/height of the frameless HUD (from the window spec). */
export interface WindowSize {
  width: number
  height: number
}

/** A display's usable area (its work area, menu-bar/dock excluded), in global screen coordinates. */
export interface DisplayArea {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The cursor's offset within the window at the moment the drag begins (grab point − window origin).
 * Captured once on drag-start; the window then rides the cursor keeping this offset constant, so the
 * spot you grabbed stays under the pointer for the whole drag.
 */
export const grabOffset = (cursor: ScreenPoint, origin: WindowPosition): ScreenPoint => ({
  x: cursor.x - origin.x,
  y: cursor.y - origin.y,
})

/** Where the window's origin must be so the grabbed point sits under the current cursor. Integer px. */
export const draggedOrigin = (cursor: ScreenPoint, offset: ScreenPoint): WindowPosition => ({
  x: Math.round(cursor.x - offset.x),
  y: Math.round(cursor.y - offset.y),
})

/** Serialize the remembered origin — rounded to whole pixels; nothing else about the window is stored. */
export const serializeWindowState = (pos: WindowPosition): string =>
  JSON.stringify({ x: Math.round(pos.x), y: Math.round(pos.y) })

/** Parse a persisted origin, tolerating any garbage (missing file → empty string → undefined here). */
export const parseWindowState = (raw: string): WindowPosition | undefined => {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const { x, y } = value as Record<string, unknown>
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return undefined
  return { x: Math.round(x), y: Math.round(y) }
}

/** How much of the window (in px, both axes) must stay on a display for the saved spot to be reusable. */
const MIN_VISIBLE = 80

const overlap = (aStart: number, aLen: number, bStart: number, bLen: number): number =>
  Math.min(aStart + aLen, bStart + bLen) - Math.max(aStart, bStart)

/**
 * Is the saved origin still landable on the CURRENT displays? A monitor that was unplugged (or a
 * resolution change) can leave the remembered spot off every screen — restoring there would hide the
 * HUD entirely. We require, on some one display, a MIN_VISIBLE-px overlap in both axes AND the window's
 * top edge to sit within the work area's vertical span, so the grab strip (the top of the panel) is
 * always reachable to drag it back. Fails closed: no display satisfying → not usable → the shell centers.
 */
export const isPositionUsable = (pos: WindowPosition, size: WindowSize, displays: readonly DisplayArea[]): boolean =>
  displays.some((d) => {
    const visibleX = overlap(pos.x, size.width, d.x, d.width)
    const visibleY = overlap(pos.y, size.height, d.y, d.height)
    const topReachable = pos.y >= d.y && pos.y <= d.y + d.height - MIN_VISIBLE
    return visibleX >= MIN_VISIBLE && visibleY >= MIN_VISIBLE && topReachable
  })

/**
 * The origin to open at: the saved one if it is still on-screen, otherwise `undefined` — the shell
 * reads that as "no valid memory, center on the primary display" (the default first-run placement).
 */
export const resolveStartupPosition = (
  saved: WindowPosition | undefined,
  size: WindowSize,
  displays: readonly DisplayArea[],
): WindowPosition | undefined => (saved && isPositionUsable(saved, size, displays) ? saved : undefined)
