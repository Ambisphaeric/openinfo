import { appendFile, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { CaptureChunk, QueueFailure, QueueStatus } from '@openinfo/contracts'

const safeName = (value: string): string => value.replace(/[^a-zA-Z0-9._-]/g, '_')

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

  constructor(
    private readonly queueDir: string,
    private readonly processor?: DrainProcessor,
    private readonly describeFailure?: DrainFailureDescriber,
  ) {}

  async append(chunk: CaptureChunk): Promise<void> {
    await mkdir(this.queueDir, { recursive: true })
    await appendFile(this.pendingPath(chunk.sessionId), `${JSON.stringify(chunk)}\n`, 'utf8')
  }

  async status(): Promise<QueueStatus> {
    await mkdir(this.queueDir, { recursive: true })
    const files = (await readdir(this.queueDir)).filter((file) => file.endsWith('.jsonl'))
    let pendingBytes = 0
    for (const file of files) pendingBytes += (await stat(join(this.queueDir, file))).size
    return {
      pendingFiles: files.length,
      pendingBytes,
      drainedFiles: this.drainedFiles,
      updatedAt: new Date().toISOString(),
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
        try {
          await this.processor(await this.parse(draining))
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
