/**
 * Pause-based (VAD) segment-rotation logic — the decision half of the #95 chunking-architecture fix.
 *
 * Root cause (measured, tools/stt-accuracy): the shipped 0.0.8 default cut audio into FIXED 1-second
 * segments and transcribed each one independently. A cut on the wall clock lands mid-word roughly once a
 * second at natural speaking pace, and the model — given a word fragment with zero context — fabricates a
 * phantom word ('testing testing testing' → the boundary chunk came back 'thing.'). The harness put a
 * number on it: fixed-1s scored ~0.20 WER against a whole-file 0.00 across the speech fixtures, and even
 * fixed-5s still corrupted a boundary word inside a continuous monologue ('straddle a boundary' →
 * 'stress Battle of Boundary'). Cutting at SILENCE instead of the clock ('vad') scored 0.00 — it matches
 * whole-file, because a cut in a pause never splits a word. (The overlap+merge candidate scored WORSE —
 * ~0.69 WER — because a naive exact-word-overlap merge duplicates the boundary span when the same audio
 * transcribes differently in adjacent windows; see the PR for why it was rejected.)
 *
 * This module is PURE and browser-free so it is unit-tested in the node env: the capture renderer feeds it
 * amplitude telemetry each poll tick and asks `shouldRotate` when to stop-and-restart the MediaRecorder.
 * The renderer's actual getUserMedia/AnalyserNode plumbing stays in capture-renderer.ts (not CI-tested).
 */

/** How the renderer decides WHERE to cut one audio segment. `fixed` = the old wall-clock cadence. */
export type ChunkStrategy = 'fixed' | 'vad'

/** The tunable VAD knobs (all ms except the amplitude floor). Resolved from config; clamped here. */
export interface VadParams {
  /** Consecutive sub-threshold (quiet) time that counts as a real pause and triggers a cut. */
  silenceHoldMs: number
  /** Never cut before this much audio has been captured — avoids shipping sub-word fragments. */
  minSegmentMs: number
  /** Always cut by this long even with NO pause — the fallback for pauseless speech (bounds latency). */
  maxSegmentMs: number
  /** Peak time-domain amplitude (0..1) below which a poll tick counts as silence, not speech. */
  silencePeak: number
  /** How often the renderer samples amplitude + re-asks shouldRotate. */
  pollMs: number
}

/**
 * Defaults chosen FROM the tools/stt-accuracy measurements (parakeet + whisper, both localhost):
 * - silenceHoldMs 400 — a clear inter-phrase pause; long enough not to trip on the ~100–200ms gaps
 *   between ordinary words (which would recreate the 1s over-slicing), short enough that a finished
 *   utterance ships ~0.4s after the speaker stops (the dominant latency, comparable to the old 1s cadence
 *   for conversational speech, and NEVER mid-word).
 * - minSegmentMs 600 — floor so a brief cough/word doesn't emit a tiny fragment.
 * - maxSegmentMs 6000 — pauseless-monologue cap; measured fixed-5s stayed at ~0.04 WER, so ~6s chunks are
 *   an acceptable accuracy fallback while bounding worst-case latency. This is the accuracy↔latency dial.
 * - silencePeak 0.02 — above digital silence / ambient room floor, below conversational speech peaks
 *   (~0.1–0.5); the existing system-audio probe's 1e-3 is DIGITAL-silence detection, a different job.
 * - pollMs 50 — 20 Hz amplitude sampling; fine-grained enough to place a cut within a pause.
 */
export const DEFAULT_VAD_PARAMS: VadParams = {
  silenceHoldMs: 400,
  minSegmentMs: 600,
  maxSegmentMs: 6000,
  silencePeak: 0.02,
  pollMs: 50,
}

/** The measured product default strategy (#95): cut at pauses, not the wall clock. */
export const DEFAULT_CHUNK_STRATEGY: ChunkStrategy = 'vad'

const posInt = (v: number | undefined, def: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : def

const posFloat = (v: number | undefined, def: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : def

/**
 * Clamp a partial set of VAD knobs into a valid, self-consistent VadParams: each field falls back to its
 * default when absent/garbage, and maxSegmentMs is raised to at least minSegmentMs so the cap can never
 * undercut the floor (which would rotate every tick). Pure — the renderer and config both lean on it.
 */
export const resolveVadParams = (partial?: Partial<VadParams>): VadParams => {
  const silenceHoldMs = posInt(partial?.silenceHoldMs, DEFAULT_VAD_PARAMS.silenceHoldMs)
  const minSegmentMs = posInt(partial?.minSegmentMs, DEFAULT_VAD_PARAMS.minSegmentMs)
  const maxRaw = posInt(partial?.maxSegmentMs, DEFAULT_VAD_PARAMS.maxSegmentMs)
  const maxSegmentMs = Math.max(maxRaw, minSegmentMs)
  const silencePeak = posFloat(partial?.silencePeak, DEFAULT_VAD_PARAMS.silencePeak)
  const pollMs = posInt(partial?.pollMs, DEFAULT_VAD_PARAMS.pollMs)
  return { silenceHoldMs, minSegmentMs, maxSegmentMs, silencePeak, pollMs }
}

/** Coerce an arbitrary value to a known ChunkStrategy, else undefined (caller supplies the default). */
export const asChunkStrategy = (v: unknown): ChunkStrategy | undefined =>
  v === 'fixed' || v === 'vad' ? v : undefined

/**
 * Fold one poll tick into the running silence timer: reset to 0 the moment amplitude rises to/through the
 * speech floor, otherwise extend the quiet run by the elapsed tick. Feeding this the per-tick peak lets
 * shouldRotate see how long the current pause has lasted.
 */
export const nextSilenceRunMs = (prevRunMs: number, tickMs: number, peak: number, silencePeak: number): number =>
  peak < silencePeak ? prevRunMs + tickMs : 0

/**
 * The rotation decision, evaluated each poll tick. Cut when EITHER:
 * - we've hit the max cap (pauseless speech — bound latency), OR
 * - we've captured at least the minimum AND have been quiet long enough to call it a pause (the cut then
 *   lands in silence, never mid-word — the whole point of the fix).
 */
export const shouldRotate = (elapsedMs: number, silenceRunMs: number, p: VadParams): boolean => {
  if (elapsedMs >= p.maxSegmentMs) return true
  return elapsedMs >= p.minSegmentMs && silenceRunMs >= p.silenceHoldMs
}
