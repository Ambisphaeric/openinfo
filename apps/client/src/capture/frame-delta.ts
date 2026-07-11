/**
 * The screen Δ-gate (issue #5) — the first-pass "did the screen actually change?" decision, lifted out of
 * shell.ts so the byte-diff and the keep/skip policy are pure and headless-assertable, exactly as
 * screen-source.ts does for the cadence. Electron-free: shell.ts supplies a tiny downscaled probe bitmap
 * (NativeImage.resize → toBitmap) per grabbed frame; this module compares it against the last KEPT probe
 * for that display and says whether the frame is worth sending at all. A static screen is otherwise
 * re-JPEG'd and re-OCR'd forever — the gate is where that stops, client-side, before any bytes leave.
 *
 * Design points:
 * - The score compares against the last KEPT frame, not the last SEEN one, so slow gradual change
 *   accumulates until it crosses the threshold instead of hiding under it tick after tick. This is also
 *   exactly what the contract field means: `ScreenFrameMeta.deltaScore` = "how much this frame changed vs
 *   the last kept one".
 * - A HEARTBEAT lets one frame through every `heartbeatEvery` gated ticks regardless of score, so a
 *   genuinely static screen still proves the stream is alive downstream (and any probe blind spot is
 *   bounded at one heartbeat interval, not forever).
 * - State is keyed by displayId. Capture is primary-display-only today, but the keying makes multi-display
 *   free later and guards against the primary display CHANGING mid-session (a new id = a first frame).
 * - `threshold: 0` disables gating arithmetically (every score ≥ 0), so "gate off" needs no special case
 *   and still measures + stamps deltaScore — free telemetry for tuning the default.
 */

/**
 * Default keep threshold — the fraction of sampled probe bytes that must differ (beyond the per-byte
 * tolerance) for a frame to be kept. 1.5% of a 32px-wide probe ≈ a dozen changed samples: a new line of
 * text or a window change crosses it; sub-pixel shimmer and the wall clock's seconds generally don't.
 * First-pass guess — the OCR-economics measurement that would tune it is deliberately follow-up.
 */
export const DELTA_THRESHOLD_DEFAULT = 0.015

/**
 * Safety heartbeat: send anyway after this many consecutive gated ticks. At the 3–6s cadence band this
 * bounds "downstream last saw the screen" at ~30–60s on a fully static display.
 */
export const DELTA_HEARTBEAT_TICKS = 10

/** Per-byte tolerance — |a−b| must EXCEED this for a sampled byte to count as changed (rides out JPEG-free
 * resize jitter and compositor noise without hiding real content changes). */
export const DELTA_BYTE_TOLERANCE = 8

/**
 * Sample every Nth byte of the probe for speed. NOTE the honest caveat: on the BGRA bitmaps NativeImage
 * produces, a stride of 4 lands on ONE channel (blue). Accepted for pass 1 — real UI/text changes move
 * blue somewhere in a 32px probe, and the heartbeat bounds any blind spot — but it is a stride, not a law.
 */
export const DELTA_SAMPLE_STRIDE = 4

/** Width (px) of the downscaled comparison probe shell.ts derives from the full thumbnail (aspect kept). */
export const DELTA_PROBE_WIDTH = 32

/**
 * Fraction (0..1) of sampled bytes differing beyond `tolerance` between two same-display probe bitmaps.
 * A length mismatch (display resolution/rotation changed between ticks) is total change by definition → 1,
 * as is an empty probe (nothing to compare — fail open, let the frame through).
 */
export const computeDeltaScore = (
  a: Uint8Array,
  b: Uint8Array,
  tolerance: number = DELTA_BYTE_TOLERANCE,
  stride: number = DELTA_SAMPLE_STRIDE,
): number => {
  if (a.length !== b.length || a.length === 0) return 1
  let sampled = 0
  let changed = 0
  for (let i = 0; i < a.length; i += stride) {
    sampled++
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d > tolerance || d < -tolerance) changed++
  }
  return changed / sampled
}

/**
 * The keep/skip policy, pure: keep when the frame changed enough, OR when the heartbeat is due. With
 * `threshold` 0 the first clause is always true — that is the documented "gating disabled" mode.
 */
export const shouldSend = (
  deltaScore: number,
  ticksSinceLastSend: number,
  threshold: number = DELTA_THRESHOLD_DEFAULT,
  heartbeatEvery: number = DELTA_HEARTBEAT_TICKS,
): boolean => deltaScore >= threshold || ticksSinceLastSend >= heartbeatEvery

/** One gate decision: whether to send, the measured score (stamped into ScreenFrameMeta.deltaScore when
 * sending), and — when skipping — how many consecutive ticks this display has now been gated (for
 * throttled logging; 0 on a send). */
export interface FrameDeltaVerdict {
  send: boolean
  deltaScore: number
  skipStreak: number
}

/**
 * The per-display gate state holder: last KEPT probe + ticks since the last send, keyed by displayId.
 * One instance lives in shell.ts beside the cadence handle; `reset()` is called on each session's loop
 * start so the first frame of a session always sends (no prior probe ⇒ score 1).
 */
export class FrameDeltaGate {
  private readonly threshold: number
  private readonly heartbeatEvery: number
  private readonly displays = new Map<string, { last: Uint8Array; ticksSinceLastSend: number }>()

  constructor(threshold: number = DELTA_THRESHOLD_DEFAULT, heartbeatEvery: number = DELTA_HEARTBEAT_TICKS) {
    this.threshold = threshold
    this.heartbeatEvery = heartbeatEvery
  }

  /** Score `probe` against this display's last kept probe and decide keep/skip (updating state either way). */
  assess(displayId: string, probe: Uint8Array): FrameDeltaVerdict {
    const state = this.displays.get(displayId)
    if (!state) {
      // First frame for this display (session start, or the primary display changed): always send.
      this.displays.set(displayId, { last: probe, ticksSinceLastSend: 0 })
      return { send: true, deltaScore: 1, skipStreak: 0 }
    }
    const deltaScore = computeDeltaScore(state.last, probe)
    const ticks = state.ticksSinceLastSend + 1 // this tick, counted from the last kept frame
    if (shouldSend(deltaScore, ticks, this.threshold, this.heartbeatEvery)) {
      state.last = probe
      state.ticksSinceLastSend = 0
      return { send: true, deltaScore, skipStreak: 0 }
    }
    state.ticksSinceLastSend = ticks
    return { send: false, deltaScore, skipStreak: ticks }
  }

  /** Forget all displays — a fresh session's first frame must always send. */
  reset(): void {
    this.displays.clear()
  }
}
