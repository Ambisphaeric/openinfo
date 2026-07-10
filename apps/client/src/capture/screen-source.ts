/**
 * The screen-capture cadence driver (issue #4) — the one place that turns a resolved interval into the
 * periodic still-frame grab loop, lifted out of shell.ts so the "screen source honours the configured
 * cadence" behaviour is asserted headless with a fake timer, exactly as #57 does for the audio segment
 * cadence (capture-renderer.test.ts). Electron-free: it takes an async `grab` callback (shell.ts supplies
 * the desktopCapturer → NativeImage.toJPEG grab) and schedules on the global timers, which a test replaces
 * with a spy — no display, no BrowserWindow, no wall-clock wait.
 *
 * Behaviour it preserves from the old inline startScreenLoop: grab ONE frame immediately (so the first
 * frame isn't a full interval away), then grab on the configured cadence; stop() clears the timer and is
 * idempotent. The interval it schedules on is exactly the value config.ts resolved+CLAMPED into the 3–6s
 * band (resolveScreenIntervalMs) — this driver does not re-clamp (it trusts the resolver), it just honours
 * it, so a cadence change is a single-source decision.
 */

/** A running screen cadence loop. */
export interface ScreenCadenceHandle {
  /** Stop the cadence loop. Idempotent — a second call is a no-op (mirrors stopScreenLoop's guard). */
  stop(): void
}

export interface ScreenCadenceDeps {
  /** The resolved+clamped grab cadence in ms (config.ts's screenIntervalMs — already in the 3–6s band). */
  intervalMs: number
  /**
   * Grab one screen still frame. Fire-and-forget: the loop keeps ticking regardless of the promise, and
   * any error is the grab's own to log (shell.ts's captureScreenFrame swallows + logs its failures).
   */
  grab: () => void | Promise<void>
}

/**
 * Start the screen cadence: grab immediately, then every `intervalMs`. Returns a handle whose `stop()`
 * ends the loop. Uses the global setInterval/clearInterval so a test can fake them (the #57 pattern).
 */
export const startScreenCadence = (deps: ScreenCadenceDeps): ScreenCadenceHandle => {
  void deps.grab() // first frame now, so the first isn't a full interval away
  const timer = setInterval(() => void deps.grab(), deps.intervalMs)
  let stopped = false
  return {
    stop(): void {
      if (stopped) return
      stopped = true
      clearInterval(timer)
    },
  }
}
