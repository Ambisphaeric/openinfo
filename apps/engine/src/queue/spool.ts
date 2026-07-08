import { appendFile, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { CaptureChunk, OverflowState, QueueFailure, QueueStatus } from '@openinfo/contracts'
import { countWork, emptyByKind, tallyFile } from './kinds.js'
import { projectEta, type DrainSample } from './eta.js'

const safeName = (value: string): string => value.replace(/[^a-zA-Z0-9._-]/g, '_')

/** Most recent drain samples kept for the ETA (in-memory, operational — like drainedFiles, not a document). */
const DRAIN_SAMPLE_WINDOW = 20

/**
 * READ-ONLY seams the queue calls for the envelope/overflow surfacing (P4A slice 3), injected from
 * api/http.ts so the queue keeps ZERO fabric/store imports (the describeFailure precedent):
 *  - measuredTokPerSec: the active llm endpoint's benchmarked tok/s (fabric §8 `measured`) — echoed as
 *    the envelope's measured side; never converted to an ETA in v0.
 *  - overflow: the declared overflow policy (from the active mode) + whether v0 enforces it.
 */
export type MeasuredRate = () => number | undefined
export type OverflowProvider = () => OverflowState | undefined

/**
 * Invoked once per drained file with its parsed chunks (the distiller's seam — see PHASE2-NOTES).
 * If it throws, the file is returned to the pending path so capture is never lost (retry-at-idle).
 * When no processor is supplied the drain is a no-op that GCs drained files (Phase 1 behavior).
 */
export type DrainProcessor = (chunks: CaptureChunk[]) => Promise<void>

/**
 * Classify a drain-processor throw into the surface-ready QueueFailure (INVOKE-RESILIENCE). Injected so
 * the queue stays free of any invoke/fabric dependency (it only calls this) — wired in api/http.ts to the
 * fabric's toQueueFailure. Returns undefined for a non-invoke error (kept unclassified, still logged).
 */
export type DrainFailureDescriber = (error: unknown, at: string) => Promise<QueueFailure | undefined>

export class CaptureQueue {
  private drainedFiles = 0
  private draining = false
  // Operational status, NOT a document (justification, per the slice brief): the last drain failure and
  // last drain success are ephemeral runtime facts about THIS engine process — they carry no user intent,
  // are recomputed every run, and have no version history worth keeping. So they live in memory on the
  // queue (surfaced via status()/GET /queue/WS), exactly like drainedFiles, not in the store.
  private lastFailure?: QueueFailure
  private lastSuccessAt?: string
  // Recent per-file drain samples (work-chunks + processor ms) — the honest drain-rate signal the ETA
  // divides the backlog by. In-memory + ring-bounded, same operational justification as lastFailure.
  private drainSamples: DrainSample[] = []

  constructor(
    private readonly queueDir: string,
    private readonly processor?: DrainProcessor,
    private readonly describeFailure?: DrainFailureDescriber,
    private readonly measuredTokPerSec?: MeasuredRate,
    private readonly overflow?: OverflowProvider,
  ) {}

  async append(chunk: CaptureChunk): Promise<void> {
    await mkdir(this.queueDir, { recursive: true })
    await appendFile(this.pendingPath(chunk.sessionId), `${JSON.stringify(chunk)}\n`, 'utf8')
  }

  async status(): Promise<QueueStatus> {
    await mkdir(this.queueDir, { recursive: true })
    const files = (await readdir(this.queueDir)).filter((file) => file.endsWith('.jsonl'))
    let pendingBytes = 0
    // Per-kind depth (P4A slice 3): the durable unit is the per-session file, but a file mixes kinds, so
    // an honest per-kind depth has to parse the pending files and classify each chunk. Best-effort — a
    // file renamed out from under us (a concurrent drain) or a corrupt line is skipped for the kind tally
    // but still counted in pendingFiles/pendingBytes. v0 cost is O(pending bytes) per status(); acceptable
    // because the backlog only grows when the model is slow/down (else it drains immediately), and a
    // future incremental-counter optimization is deferred (PHASE4-NOTES).
    const byKind = emptyByKind()
    for (const file of files) {
      const path = join(this.queueDir, file)
      let fileBytes = 0
      try {
        fileBytes = (await stat(path)).size
      } catch {
        continue
      }
      pendingBytes += fileBytes
      try {
        tallyFile(await this.parse(path), fileBytes, byKind)
      } catch {
        // unreadable/racing file — its bytes still count; its kinds do not
      }
    }
    const backlogChunks = byKind.audio.pendingChunks + byKind.screen.pendingChunks + byKind['llm-work'].pendingChunks
    const measured = this.measuredTokPerSec?.()
    const eta = projectEta({
      backlogChunks,
      samples: this.drainSamples,
      now: Date.now(),
      ...(measured !== undefined ? { measuredTokPerSec: measured } : {}),
    })
    const overflow = this.overflow?.()
    return {
      pendingFiles: files.length,
      pendingBytes,
      drainedFiles: this.drainedFiles,
      updatedAt: new Date().toISOString(),
      byKind,
      eta,
      ...(overflow !== undefined ? { overflow } : {}),
      ...(this.lastFailure !== undefined ? { lastFailure: this.lastFailure } : {}),
      ...(this.lastSuccessAt !== undefined ? { lastSuccessAt: this.lastSuccessAt } : {}),
    }
  }

  scheduleDrain(logger: (line: string) => void = console.log): void {
    if (this.draining) return
    this.draining = true
    setImmediate(() => {
      void this.drain(logger).finally(() => {
        this.draining = false
      })
    })
  }

  /**
   * Await a full drain of everything currently pending. Waits out any in-flight scheduled drain,
   * then runs one guarded pass so all pending files are processed before it resolves. Used by the
   * Act trigger on session end: the follow-up draft must reflect the whole meeting, so any chunks
   * still in the queue are distilled first (see PHASE2-NOTES: the ≤60s story).
   */
  async drainNow(logger: (line: string) => void = console.log): Promise<void> {
    while (this.draining) await new Promise((resolve) => setTimeout(resolve, 5))
    this.draining = true
    try {
      await this.drain(logger)
    } finally {
      this.draining = false
    }
  }

  private async drain(logger: (line: string) => void): Promise<void> {
    await mkdir(this.queueDir, { recursive: true })
    const files = (await readdir(this.queueDir)).filter((file) => file.endsWith('.jsonl')).sort()
    for (const file of files) {
      const pending = join(this.queueDir, file)
      const draining = join(this.queueDir, `${file}.draining`)
      try {
        await rename(pending, draining)
      } catch {
        continue
      }
      if (this.processor) {
        const startedAt = performance.now()
        let workChunks = 0
        try {
          const parsed = await this.parse(draining)
          workChunks = countWork(parsed)
          await this.processor(parsed)
        } catch (error) {
          // The drain no longer re-queues SILENTLY (the founder's wall): classify why it failed and record
          // it so GET /queue / Status / the Try-it card can surface the real reason. A non-invoke error
          // (undescribable) is still logged and re-queued, just without a class — no false diagnosis.
          const at = new Date().toISOString()
          const failure = this.describeFailure ? await this.describeFailure(error, at) : undefined
          if (failure) this.lastFailure = failure
          logger(
            `queue drain processor failed on ${file}, re-queued: ${failure ? `[${failure.class}] ${failure.hint}` : error instanceof Error ? error.message : String(error)}`,
          )
          await rename(draining, pending).catch(() => undefined)
          continue
        }
        // A successful drain is one honest rate sample (work-chunks over processor ms) for the ETA.
        this.drainSamples.push({ chunks: workChunks, ms: performance.now() - startedAt })
        if (this.drainSamples.length > DRAIN_SAMPLE_WINDOW) this.drainSamples.shift()
      } else {
        logger(`queue drain no-op processed ${file}`)
      }
      await rm(draining, { force: true })
      this.drainedFiles += 1
      this.lastSuccessAt = new Date().toISOString()
    }
  }

  private async parse(path: string): Promise<CaptureChunk[]> {
    const raw = await readFile(path, 'utf8')
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as CaptureChunk)
  }

  private pendingPath(sessionId: string): string {
    return join(this.queueDir, `${safeName(sessionId)}.jsonl`)
  }
}
