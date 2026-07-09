/**
 * The capture consent / boot guard (issue #41).
 *
 * Capture is no-wake-word CONTINUOUS ingestion, so turning it ON must be an explicit user act EVERY
 * launch — the client must never auto-resume capture on boot just because a session is still live on
 * the engine (a session outliving a force-killed client, or a `before-quit` that could not end it in
 * time). This is the deterministic safety net behind "end the session on quit": even if that end never
 * ran, capture stays OFF until the user starts it this launch.
 *
 * The rule is deliberately tiny and pure so it is asserted headless (shell.ts, which owns the electron
 * edges, is never unit-tested): a live-session transition only drives capture when the user granted
 * consent by clicking Start Session in THIS process. `grant()` fires from the Start dispatch; `revoke()`
 * from the End dispatch and from quit. Consent PERSISTS across the engine's auto-end→restart (clicking
 * Start while a session is live emits ended(old)+started(new) — both belong to the same user gesture),
 * so it is cleared only by an explicit End or by quitting, never by the transient WS transitions.
 */
export class CaptureConsent {
  private consented = false

  /** The user asked to start capturing this launch (tray Start Session). */
  grant(): void {
    this.consented = true
  }

  /** The user ended the session, or the app is quitting — future live transitions must not auto-start. */
  revoke(): void {
    this.consented = false
  }

  /**
   * May a live-session transition start capture right now? True only after an explicit Start this launch.
   * The boot seed of a leftover live session reads false here, so capture stays stopped until the user acts.
   */
  get canAutoStart(): boolean {
    return this.consented
  }
}
