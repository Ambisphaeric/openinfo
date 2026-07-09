/**
 * The HUD boot controller — the fix for the invisible-HUD failure class. The HUD window is frameless
 * and fully TRANSPARENT, so any silent failure paints literally nothing: the packaged shell creates the
 * window (and the renderer fires its one-shot fetches) BEFORE `ensureEngine()` finishes spawning the
 * bundled engine, and the old `void hud.start()` swallowed that rejection — a permanently blank window
 * with no retry, no reconnect, and no error UI (the same silent-no-op disease the settings Save had).
 *
 * This controller makes boot self-healing and VISIBLE: it retries `start()` with capped backoff forever
 * (the engine may legitimately appear/restart at any time), reports every state through `onStatus` (the
 * dev entry paints it as a status chip — a transparent window must never fail invisibly), and clears the
 * status on success. Pure and dependency-injected (start/stop/schedule) so the whole retry ladder is
 * asserted headless under node:test.
 */

/** Retry delays, capped: quick first retries (a spawning engine answers within seconds), then 8s forever. */
export const BOOT_BACKOFF_MS: readonly number[] = [500, 1_000, 2_000, 4_000, 8_000]

/** The delay before retry `attempt` (1-based: the delay AFTER the attempt-th failure). Pure. */
export const backoffMs = (attempt: number): number =>
  BOOT_BACKOFF_MS[Math.min(Math.max(attempt, 1), BOOT_BACKOFF_MS.length) - 1] ?? 8_000

/** One-line, human-readable boot status ("what is the HUD doing and why is it empty"). Pure. */
export const bootStatusText = (engineLabel: string, attempt: number, error: unknown): string => {
  const reason = error instanceof Error ? error.message : String(error)
  return `waiting for engine at ${engineLabel} — ${reason} (retry ${attempt})`
}

export interface BootDeps {
  /** Start the HUD (surface fetch + hydrate + subscribe). Rejection ⇒ retry. */
  start: () => Promise<void>
  /** Tear down any partial subscription before a retry (Hud.stop is idempotent). */
  stop: () => void
  /** Paint the boot status; null ⇒ booted, clear the chip. */
  onStatus: (text: string | null) => void
  /** The engine URL shown in the status line. */
  engineLabel: string
  /** Injectable timer (tests use a manual scheduler). */
  schedule?: (fn: () => void, ms: number) => void
}

export interface BootController {
  /** Kick off the boot loop (idempotent while a boot is already in flight). */
  boot: () => void
  /** A later runtime failure (e.g. the engine vanished mid-session): show it and re-enter the boot loop. */
  restart: (error: unknown) => void
}

/**
 * Build the boot controller: `boot()` attempts `start()`, retries on failure with `backoffMs`, and
 * reports through `onStatus`. `restart(err)` is the runtime honesty hook — a failure AFTER a successful
 * boot (WS-triggered refresh threw, engine gone) stops the HUD, shows why, and re-enters the same loop.
 */
export const createBootController = (deps: BootDeps): BootController => {
  const schedule = deps.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  let attempt = 0
  let inFlight = false

  const tryStart = (): void => {
    inFlight = true
    deps.start().then(
      () => {
        inFlight = false
        attempt = 0
        deps.onStatus(null)
      },
      (error: unknown) => {
        inFlight = false
        attempt += 1
        deps.stop() // drop any partial subscription so the retry starts clean
        deps.onStatus(bootStatusText(deps.engineLabel, attempt, error))
        schedule(tryStart, backoffMs(attempt))
      },
    )
  }

  return {
    boot: () => {
      if (inFlight) return
      tryStart()
    },
    restart: (error: unknown) => {
      if (inFlight) return
      deps.stop()
      attempt += 1
      deps.onStatus(bootStatusText(deps.engineLabel, attempt, error))
      schedule(tryStart, backoffMs(attempt))
    },
  }
}
