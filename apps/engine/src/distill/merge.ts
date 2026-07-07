import type { CaptureChunk } from '@openinfo/contracts'

export interface MergeWindowConfig {
  /** floor of a window; a gap larger than this closes the current window (a new topic began) */
  shortSec: number
  /** hard cap: a window never spans more than this (the "→ 2m" in 30s→2m rolling merge) */
  longSec: number
}

export interface MergeWindow {
  chunks: CaptureChunk[]
  start: string
  end: string
}

const ms = (iso: string): number => new Date(iso).getTime()

/**
 * Bucket a batch of raw capture chunks into rolling merge windows (default 30s → 2m).
 *
 * Deterministic rule (documented in PHASE2-NOTES): sort by capturedAt, then greedily fill a
 * window. The next chunk joins the current window iff it stays within the longSec cap from the
 * window start AND the gap since the previous chunk is under shortSec. A larger gap closes the
 * window early (a lull marks a topic boundary); the 2m cap bounds a continuous stream.
 */
export const bucketIntoWindows = (chunks: readonly CaptureChunk[], config: MergeWindowConfig): MergeWindow[] => {
  const sorted = [...chunks].sort((a, b) => ms(a.capturedAt) - ms(b.capturedAt) || a.sequence - b.sequence)
  const windows: MergeWindow[] = []
  const shortMs = config.shortSec * 1000
  const longMs = config.longSec * 1000

  for (const chunk of sorted) {
    const open = windows[windows.length - 1]
    if (open) {
      const startMs = ms(open.start)
      const lastMs = ms(open.chunks[open.chunks.length - 1]!.capturedAt)
      const at = ms(chunk.capturedAt)
      const withinCap = at - startMs < longMs
      const gapOk = at - lastMs < shortMs
      if (withinCap && gapOk) {
        open.chunks.push(chunk)
        open.end = chunk.capturedAt
        continue
      }
    }
    windows.push({ chunks: [chunk], start: chunk.capturedAt, end: chunk.capturedAt })
  }
  return windows
}
