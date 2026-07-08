import type { FrontmostWindow } from '../capture/focus.js'

/**
 * Tracks whether context detection is actually WORKING, to drive the tray's "grant Accessibility for
 * context detection" fix-it. Pure + electron-free (fed observations, it answers a boolean) so the trigger
 * state is asserted headless; the shell (shell.ts) feeds it each focus sample and reads `needsAccessibility`.
 *
 * THE HONEST SIGNAL: the focus poller runs only when the engine's `route.detect` flag is on AND the local
 * opt-out isn't set (`active`). While active, each osascript sample of the frontmost window either fails
 * (Accessibility denied ⇒ the read throws ⇒ the shell passes `undefined`), returns an app name but NO
 * window title (Accessibility granted but the title is gated / not exposed), or returns a title (working).
 * We surface the fix-it when we have sampled at least once while active but have NEVER seen a title —
 * i.e. context detection is on but not yielding usable window context. The tray item opens the
 * Accessibility pane (the primary grant `osascript` needs; the docs note some apps also gate titles
 * behind Screen Recording). Once ANY title is seen the hint clears; stopping the poller resets it, so a
 * later re-enable re-evaluates from scratch. No fake detection — this is derived from real sample outcomes.
 */
export interface ContextHealth {
  /** Is the focus poller currently active (route.detect on + local opt-in)? */
  active: boolean
  /** Has at least one sample run since becoming active? */
  sampled: boolean
  /** Has any sample since becoming active returned a window title? */
  sawTitle: boolean
}

/** Pure predicate: guide to Accessibility when active + sampled + never a title. */
export const needsAccessibilityGrant = (h: ContextHealth): boolean => h.active && h.sampled && !h.sawTitle

export class ContextHealthTracker {
  private active = false
  private sampled = false
  private sawTitle = false

  /** The poller flipped active/inactive. Going inactive resets the observation window. */
  setActive(active: boolean): void {
    this.active = active
    if (!active) {
      this.sampled = false
      this.sawTitle = false
    }
  }

  /** Record one sample outcome (undefined = the osascript read failed). No-op while inactive. */
  observe(window: FrontmostWindow | undefined): void {
    if (!this.active) return
    this.sampled = true
    if (window?.windowTitle) this.sawTitle = true
  }

  /** Whether the tray should show the Accessibility fix-it right now. */
  get needsAccessibility(): boolean {
    return needsAccessibilityGrant({ active: this.active, sampled: this.sampled, sawTitle: this.sawTitle })
  }
}
