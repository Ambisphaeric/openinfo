import { type CaptureChunk, FocusSignal } from '@openinfo/contracts'
import { Value } from '@sinclair/typebox/value'
import type { TimedFocusSignal } from './detector.js'

/**
 * A focus capture chunk: source 'focus', utf8 JSON body (a FocusSignal). This is also the exclusion
 * predicate distill uses to keep foreground context out of transcripts — a focus chunk is evidence for
 * WHERE a session belongs, never content IN one (see distiller.isText).
 */
export const isFocusChunk = (chunk: CaptureChunk): boolean =>
  chunk.source === 'focus' || (chunk.encoding === 'utf8' && chunk.contentType === 'application/json')

/**
 * Decode a drained spool batch's focus chunks into timed FocusSignals for the detector. Each focus
 * chunk's `data` is JSON.parse'd and contract-validated; a malformed/invalid body is skipped (logged),
 * never thrown — a bad focus signal must not fail the drain and re-queue speech. `at` is the chunk's
 * capturedAt, so the detector windows by capture time, not arrival order.
 */
export const extractFocusSignals = (
  chunks: readonly CaptureChunk[],
  log: (message: string) => void = () => undefined,
): TimedFocusSignal[] => {
  const out: TimedFocusSignal[] = []
  for (const chunk of chunks) {
    if (chunk.source !== 'focus') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(chunk.data)
    } catch {
      log(`focus: chunk ${chunk.id} has non-JSON data, skipped`)
      continue
    }
    if (!Value.Check(FocusSignal, parsed)) {
      log(`focus: chunk ${chunk.id} failed FocusSignal validation, skipped`)
      continue
    }
    out.push({ at: chunk.capturedAt, signal: parsed })
  }
  return out
}
