/**
 * Pure resolver for the content-sized HUD's window height — headless-testable so the clamping is
 * asserted without a real BrowserWindow (the shell just wires this into setContentSize; see shell.ts).
 * The renderer measures the painted panel (auto-resize.ts) and sends it over `hud:resize`; a measurement
 * can be fractional (getBoundingClientRect), zero (nothing painted yet), or non-finite (a torn-down
 * frame), so the shell never trusts it raw:
 *   - non-finite (NaN/Infinity) ⇒ fall back to the floor (`min`) — never resize to garbage,
 *   - fractional ⇒ ceil (a floored pixel would clip the last row by a hair),
 *   - cap at `max` when given (the display work-area height — the window never grows off-screen),
 *   - floor at `min` (HUD_MIN_HEIGHT — the empty-state bar, so a quiet HUD keeps a sane bar height).
 */
export const resolveHudHeight = (measured: number, opts: { min: number; max?: number }): number => {
  const base = Number.isFinite(measured) ? Math.ceil(measured) : opts.min
  const capped = opts.max !== undefined ? Math.min(base, opts.max) : base
  return Math.max(capped, opts.min)
}
