import type { CaptureChunk } from '@openinfo/contracts'
import {
  buildFocusSignal,
  focusChunk,
  focusSignalKey,
  FOCUS_MIN_EMIT_INTERVAL_MS,
  FOCUS_POLL_INTERVAL_MS,
  type FrontmostWindow,
} from './focus.js'

/**
 * The focus-capture lifecycle brain — pure and electron-free, so the whole privacy-gating state machine
 * (flag on/off, client opt-out, no-poll-when-off), the on-change dedupe, and the burst throttle are
 * asserted headless. The shell (shell.ts) owns the ONE electron edge — the osascript sample of the
 * frontmost app/window — and the timer; nothing here imports electron.
 *
 * WHY A DEDICATED POLLER, NOT CaptureController: focus is nothing like audio. It is main-process (no
 * hidden renderer, no getUserMedia, no MediaRecorder), low-rate (one sample every few seconds vs a
 * continuous stream), session-INDEPENDENT (it runs to DETECT context, including when NO session is
 * live — it is what starts sessions), and gated on a totally different axis (an engine flag + a local
 * opt-out, not the session lifecycle). CaptureController's whole shape — permission→starting→capturing,
 * per-session context, final-segment flush, silence honesty — is audio-specific and would be dead weight
 * here. A small dedicated state machine is the honest fit (the same "rhymes-but-differs" call the
 * system-audio slice weighed and here comes down the other way).
 *
 * PRIVACY GATING (the point of this file): window titles are sensitive, so we poll ONLY when BOTH gates
 * are open — the engine's `route.detect` flag is ON (the workspace has opted into context detection) AND
 * the client-local `OPENINFO_FOCUS` opt-out is not set. When either is off we do not poll AT ALL (the
 * timer is cleared) — not poll-and-drop. Flipping the flag off mid-run stops the loop and clears the
 * dedupe memory, so nothing lingers.
 */

export interface FocusPollerDeps {
  /**
   * Read the frontmost app + window title from the OS (osascript in the shell; a stub in tests).
   * Returns undefined when the read fails (TCC denied, no frontmost window) — the poller then keeps its
   * last state and emits nothing, rather than emitting a partial or empty signal.
   */
  sample: () => Promise<FrontmostWindow | undefined>
  /**
   * Send a focus CaptureChunk to the engine. Wired in the shell to an EPHEMERAL (non-spooling) send:
   * focus signals are low-value when stale, so a failed send is dropped, never spooled (see shell.ts +
   * EngineLink.captureEphemeral). Never throws fatally — the poller logs and continues.
   */
  emit: (chunk: CaptureChunk) => Promise<unknown>
  /** The workspace focus signals are tagged with (the client's default workspace — ShellConfig). */
  workspaceId: string
  /** Stable per client run — folded into chunk ids so two runs never collide at the same sequence. */
  runId: string
  /** Client-local opt-out (OPENINFO_FOCUS, default ON): false ⇒ never poll, regardless of the flag. */
  enabled: boolean
  /** Poll cadence; defaults to FOCUS_POLL_INTERVAL_MS. */
  intervalMs?: number
  /** Minimum ms between emissions (burst throttle); defaults to FOCUS_MIN_EMIT_INTERVAL_MS. */
  minEmitIntervalMs?: number
  /** Clock injection for deterministic throttle tests; defaults to Date.now / new Date(). */
  now?: () => number
  /** Notified when active-polling flips — drives the tray's quiet "· watching context" tooltip. */
  onActiveChange?: (active: boolean) => void
  log?: (message: string) => void
}

export class FocusPoller {
  /** The engine's `route.detect` flag — the workspace-level opt-in. Off until the first /flags read. */
  private detectFlag = false
  /** Whether the sample loop is currently running (timer live). Derived from both gates via reconcile(). */
  private active = false
  private timer: ReturnType<typeof setInterval> | undefined
  private lastKey: string | undefined
  private lastEmitAt = 0
  private sequence = 0
  /** Reentrancy guard: an in-flight async sample must not overlap the next tick. */
  private sampling = false

  private readonly intervalMs: number
  private readonly minEmitIntervalMs: number
  private readonly now: () => number

  constructor(private readonly deps: FocusPollerDeps) {
    this.intervalMs = deps.intervalMs ?? FOCUS_POLL_INTERVAL_MS
    this.minEmitIntervalMs = deps.minEmitIntervalMs ?? FOCUS_MIN_EMIT_INTERVAL_MS
    this.now = deps.now ?? Date.now
  }

  /** Is the sample loop currently running? (test/tray observability) */
  get isActive(): boolean {
    return this.active
  }

  /** The engine flag flipped (from the initial /flags read or a `flag.changed` event) — reconcile the loop. */
  setDetectEnabled(on: boolean): void {
    if (on === this.detectFlag) return
    this.detectFlag = on
    this.reconcile()
  }

  /** Stop cleanly (app quitting / teardown). Idempotent. */
  stop(): void {
    this.detectFlag = false
    this.reconcile()
  }

  /**
   * One sample cycle — public so tests drive it directly without a real timer. Samples the frontmost
   * window, builds the redacted signal, dedupes against the last emitted context, applies the burst
   * throttle, and emits a focus chunk on a genuine change. A no-op unless the loop is active.
   */
  async tick(): Promise<void> {
    if (!this.active || this.sampling) return
    this.sampling = true
    try {
      const raw = await this.sample()
      if (!raw) return // couldn't read (TCC denied / no window) — keep last state, emit nothing
      const signal = buildFocusSignal(raw)
      const key = focusSignalKey(signal)
      if (key === this.lastKey) return // unchanged context — emit-only-on-change
      const at = this.now()
      if (at - this.lastEmitAt < this.minEmitIntervalMs) return // throttled: re-evaluated next tick
      this.sequence += 1
      this.lastKey = key
      this.lastEmitAt = at
      const chunk = focusChunk(signal, { workspaceId: this.deps.workspaceId, runId: this.deps.runId }, this.sequence, new Date(at).toISOString())
      try {
        await this.deps.emit(chunk)
      } catch (err) {
        this.deps.log?.(`[focus] emit failed (dropped, not spooled): ${String(err)}`)
      }
    } finally {
      this.sampling = false
    }
  }

  private async sample(): Promise<FrontmostWindow | undefined> {
    try {
      return await this.deps.sample()
    } catch (err) {
      this.deps.log?.(`[focus] sample failed: ${String(err)}`)
      return undefined
    }
  }

  /** Open the loop iff BOTH gates allow it; otherwise ensure it is fully stopped. The privacy invariant. */
  private reconcile(): void {
    const shouldRun = this.deps.enabled && this.detectFlag
    if (shouldRun && !this.active) this.startLoop()
    else if (!shouldRun && this.active) this.stopLoop()
  }

  private startLoop(): void {
    this.active = true
    this.lastKey = undefined // a fresh run re-announces the current context
    this.deps.onActiveChange?.(true)
    this.deps.log?.(`[focus] watching context — route.detect ON (sampling every ${this.intervalMs}ms; titles redacted best-effort)`)
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
    void this.tick() // sample immediately, don't wait a full interval to announce the current window
  }

  private stopLoop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    this.active = false
    this.lastKey = undefined // forget the last context so a later re-enable re-announces
    this.deps.onActiveChange?.(false)
    this.deps.log?.(`[focus] stopped watching context (${this.deps.enabled ? 'route.detect OFF' : 'disabled by OPENINFO_FOCUS'})`)
  }
}

/**
 * Pull the effective on/off of the `route.detect` flag from a `GET /flags` array. The flag's `default`
 * IS its effective value (the engine's isFlagEnabled reads `default`, and PUT /flags/:key flips it); a
 * missing flag reads OFF, matching the engine (a feature behind an unseeded flag stays off). This is the
 * client mirror of the engine's flag-read rule — kept pure so the gate is asserted headless.
 */
export const ROUTE_DETECT_FLAG = 'route.detect'
export const detectEnabledFrom = (flags: readonly { key: string; default: boolean }[]): boolean =>
  flags.find((f) => f.key === ROUTE_DETECT_FLAG)?.default ?? false
