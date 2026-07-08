import type { BacklogEta } from '@openinfo/contracts'

/**
 * One observed drain of a single spooled file — the honest, unit-correct signal for the backlog ETA
 * (ARCHITECTURE §7: "Backlog analytics project when the queue clears at current drain rate"). Recorded
 * per successfully-drained file in spool.ts (in-memory, operational — never a document, like
 * drainedFiles/lastSuccessAt). `chunks` is the file's chunk count, `ms` the processor duration.
 */
export interface DrainSample {
  chunks: number
  ms: number
}

export interface EtaInputs {
  /** work chunks still pending (focus excluded — see kinds.ts) */
  backlogChunks: number
  /** recent drain samples, oldest-to-newest (spool.ts keeps a small ring) */
  samples: readonly DrainSample[]
  /** Date.now(), injected for deterministic tests */
  now: number
  /** the active llm endpoint's MEASURED tok/s (fabric §8) — surfaced as context, not the v0 ETA basis */
  measuredTokPerSec?: number
}

/**
 * Project when the backlog clears at the CURRENT observed drain rate (the P3 `eta.ts` design). Pure.
 *
 * Honest unknown-handling: the ETA basis is `observed` drain history or nothing. When
 * there is no usable rate (no samples, or the samples processed zero chunks / took zero time) the
 * result is `basis: 'none'` with NO etaMs/caughtUpBy — an unknown is unknown, never a fabricated ETA.
 * An empty backlog is "already caught up" (etaMs 0). `measuredTokPerSec`, when present, is echoed as the
 * envelope's measured side but does NOT itself produce an ETA in v0 (converting tok/s → a chunk ETA
 * needs a tokens-per-chunk model — deferred).
 *
 * The projection is OVERALL, not per-kind: the drain processes whole files that mix kinds, so the
 * observed rate is a mixed-kind chunks/sec (a per-kind ETA would need per-kind drain accounting — deferred).
 */
export function projectEta(inputs: EtaInputs): BacklogEta {
  const { backlogChunks, samples, now, measuredTokPerSec } = inputs
  const measured = measuredTokPerSec !== undefined ? { measuredTokPerSec } : {}

  if (backlogChunks <= 0) {
    return { basis: 'observed', etaMs: 0, caughtUpBy: new Date(now).toISOString(), ...measured }
  }

  const totalChunks = samples.reduce((sum, s) => sum + s.chunks, 0)
  const totalMs = samples.reduce((sum, s) => sum + s.ms, 0)
  if (totalChunks <= 0 || totalMs <= 0) {
    return { basis: 'none', ...measured }
  }

  const chunksPerMs = totalChunks / totalMs
  const etaMs = Math.round(backlogChunks / chunksPerMs)
  return {
    basis: 'observed',
    etaMs,
    caughtUpBy: new Date(now + etaMs).toISOString(),
    drainRateChunksPerSec: Number((chunksPerMs * 1000).toFixed(4)),
    ...measured,
  }
}
