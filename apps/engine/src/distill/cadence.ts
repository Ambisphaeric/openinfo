import type { CaptureChunk } from '@openinfo/contracts'

/**
 * Default distill cadence: distill only once the accumulated (transcribed-but-undistilled) material for
 * a session SPANS at least this many milliseconds of capture, judged from the chunks' capturedAt. 15s
 * keeps the "8–20 prompts per panel per ~5 minutes" budget while the transcript fast-path (#58) keeps
 * the timeline live. Transcription still runs every drain — only the LLM distill pass is throttled.
 */
export const DEFAULT_DISTILL_CADENCE_MS = 15_000

/**
 * The distill cadence throttle (#58). With small capture segments a per-drain distill would fire an LLM
 * call every couple of seconds — wasteful and still laggy. This accumulates each drain's ready chunks
 * per session and only releases them to the distiller once that session's buffered span crosses the
 * threshold (or on an explicit session-end flush). Carry-over lives IN MEMORY on this instance: a
 * mid-crash loses only the undistilled tail — the raw chunks remain the durable source and are
 * re-transcribed on the next drain.
 *
 * Span is judged from capturedAt (max − min) rather than a durationMs field the CaptureChunk contract
 * does not carry. Buffered non-text chunks (e.g. focus context) are harmless — the distiller's own
 * text filter drops them; they are cleared on release either way.
 */
export class DistillCadence {
  /** sessionId → its accumulated, not-yet-distilled chunks. */
  private readonly buffers = new Map<string, CaptureChunk[]>()

  constructor(private readonly thresholdMs: number = DEFAULT_DISTILL_CADENCE_MS) {}

  /**
   * Accumulate a drain's chunks; return the chunks for every session whose buffered span now reaches the
   * threshold (those sessions' buffers are cleared — they are being handed to the distiller). Sessions
   * still under threshold stay buffered for the next drain. Returns [] when nothing is yet due.
   */
  offer(chunks: readonly CaptureChunk[]): CaptureChunk[] {
    for (const chunk of chunks) {
      const buffer = this.buffers.get(chunk.sessionId) ?? []
      buffer.push(chunk)
      this.buffers.set(chunk.sessionId, buffer)
    }
    const due: CaptureChunk[] = []
    for (const [sessionId, buffer] of this.buffers) {
      if (this.spanMs(buffer) >= this.thresholdMs) {
        due.push(...buffer)
        this.buffers.delete(sessionId)
      }
    }
    return due
  }

  /**
   * Release + clear ALL buffered chunks — the session-end flush. Session-agnostic (drain seams have no
   * live session): at session end we distill whatever tail remains across every buffered session. The
   * common case is a single active session; a rare concurrent session's sub-threshold tail distilling a
   * little early is harmless. Idempotent — a second flush with nothing buffered returns [].
   */
  flush(): CaptureChunk[] {
    const out: CaptureChunk[] = []
    for (const buffer of this.buffers.values()) out.push(...buffer)
    this.buffers.clear()
    return out
  }

  /** Total chunks currently held across all sessions — for tests/observability. */
  pending(): number {
    let n = 0
    for (const buffer of this.buffers.values()) n += buffer.length
    return n
  }

  private spanMs(buffer: readonly CaptureChunk[]): number {
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (const chunk of buffer) {
      const t = Date.parse(chunk.capturedAt)
      if (Number.isNaN(t)) continue
      if (t < min) min = t
      if (t > max) max = t
    }
    return max >= min ? max - min : 0
  }
}
