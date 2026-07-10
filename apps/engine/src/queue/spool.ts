import { appendFile, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { BacklogLag, CaptureChunk, OverflowState, QueueFailure, QueueStatus } from '@openinfo/contracts'
import { classifyKind, countWork, emptyByKind, tallyFile } from './kinds.js'
import { projectEta, type DrainSample } from './eta.js'

const safeName = (value: string): string => value.replace(/[^a-zA-Z0-9._-]/g, '_')

/** Compact human age for the shed audit line (#70): `12m3s`, or `4s` under a minute. */
const fmtAge = (ms: number): string => {
  const totalSec = Math.round(ms / 1000)
  const minutes = Math.floor(totalSec / 60)
  const seconds = totalSec % 60
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`
}

/** Most recent drain samples kept for the ETA (in-memory, operational — like drainedFiles, not a document). */
const DRAIN_SAMPLE_WINDOW = 20

/**
 * Fold a file's parsed chunks into the running oldest WORK-chunk capture instant (#102 keep-time). The lag
 * metric measures how far behind the present the pipeline is, so it reads the chunks' OWN `capturedAt` (the
 * true capture time the client stamps) — focus chunks are excluded, exactly as they are from byKind/ETA
 * (routing context, never a meaningful backlog). A chunk whose `capturedAt` doesn't parse is skipped (its
 * capture time is simply unknown); it never fabricates a time. Returns the min in ms, or `current` unchanged.
 */
const foldOldestWorkCapturedAt = (chunks: readonly CaptureChunk[], current: number | undefined): number | undefined => {
  let oldest = current
  for (const chunk of chunks) {
    if (classifyKind(chunk) === 'focus') continue
    const ms = Date.parse(chunk.capturedAt)
    if (Number.isNaN(ms)) continue
    if (oldest === undefined || ms < oldest) oldest = ms
  }
  return oldest
}

/**
 * The backlog LAG (#102 keep-time) — how far behind the present the pipeline is, the backward-looking
 * companion to the forward-looking BacklogEta. ABSENT when caught up (no work backlog): absence means "0
 * behind", so nothing false renders. When a backlog exists and the oldest pending capture time was
 * recoverable, `behindMs = now − that instant` (clamped ≥ 0 against clock skew), basis `capture-time`.
 * When a backlog exists but NO capture time was recoverable (all pending files unreadable this pass), it
 * reports basis `unknown` with behindMs 0 rather than inventing a lag — an unknown is unknown.
 */
const computeLag = (backlogChunks: number, oldestCapturedAtMs: number | undefined, now: number): BacklogLag | undefined => {
  if (backlogChunks <= 0) return undefined
  if (oldestCapturedAtMs === undefined) return { behindMs: 0, basis: 'unknown' }
  return {
    behindMs: Math.max(0, now - oldestCapturedAtMs),
    oldestPendingCapturedAt: new Date(oldestCapturedAtMs).toISOString(),
    basis: 'capture-time',
  }
}

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

/**
 * READ-ONLY probe for whether a capture session is currently live (#70). Injected from api/http.ts
 * (closing over `store.liveSession`) so the queue keeps ZERO store imports — the describeFailure /
 * overflow precedent. It governs ORDER only: live ⇒ drain newest spool file first (render the present,
 * backfill the past later); idle ⇒ oldest-first (drain the backlog FIFO while nothing new arrives). When
 * absent (no probe wired) the drain behaves as idle — oldest-first — a safe default that loses nothing.
 */
export type SessionLiveProbe = () => boolean

/**
 * Default freshness horizon for the age-shed policy (#70), in minutes. Backlog whose newest activity is
 * older than this is dropped-not-processed (with accounting) so a live session never waits behind stale
 * material. 10m: long enough that a brief endpoint blip backfills normally, short enough that a live
 * session after a real stall renders the present rather than replaying a quarter-hour of dead air.
 * Env-overridable at wiring time (OPENINFO_QUEUE_MAX_AGE_MINUTES); <= 0 disables shedding entirely.
 */
export const DEFAULT_MAX_AGE_MINUTES = 10

export class CaptureQueue {
  private drainedFiles = 0
  // Count of spool files dropped by the age-shed policy (#70) — operational, in-memory, same
  // justification as drainedFiles/lastFailure. Surfaced on QueueStatus.shedFiles once > 0.
  private shedFiles = 0
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
    // Freshness-first drain (#70): the live-session probe governs ORDER; maxAgeMinutes governs the
    // age-shed policy. Both optional/positional at the tail so existing callers are untouched.
    private readonly isSessionLive?: SessionLiveProbe,
    private readonly maxAgeMinutes: number = DEFAULT_MAX_AGE_MINUTES,
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
    // Oldest still-pending WORK-chunk capture instant, folded across the pending files as we parse them —
    // the basis for the #102 lag metric. Undefined until a work chunk with a parseable capturedAt is seen.
    let oldestCapturedAtMs: number | undefined
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
        const parsed = await this.parse(path)
        tallyFile(parsed, fileBytes, byKind)
        oldestCapturedAtMs = foldOldestWorkCapturedAt(parsed, oldestCapturedAtMs)
      } catch {
        // unreadable/racing file — its bytes still count; its kinds and capture times do not
      }
    }
    const now = Date.now()
    const backlogChunks = byKind.audio.pendingChunks + byKind.screen.pendingChunks + byKind['llm-work'].pendingChunks
    const measured = this.measuredTokPerSec?.()
    const eta = projectEta({
      backlogChunks,
      samples: this.drainSamples,
      now,
      ...(measured !== undefined ? { measuredTokPerSec: measured } : {}),
    })
    const lag = computeLag(backlogChunks, oldestCapturedAtMs, now)
    const overflow = this.overflow?.()
    return {
      pendingFiles: files.length,
      pendingBytes,
      drainedFiles: this.drainedFiles,
      updatedAt: new Date().toISOString(),
      byKind,
      eta,
      ...(lag !== undefined ? { lag } : {}),
      ...(overflow !== undefined ? { overflow } : {}),
      ...(this.lastFailure !== undefined ? { lastFailure: this.lastFailure } : {}),
      ...(this.lastSuccessAt !== undefined ? { lastSuccessAt: this.lastSuccessAt } : {}),
      ...(this.shedFiles > 0 ? { shedFiles: this.shedFiles } : {}),
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
    const maxAgeMs = this.maxAgeMinutes > 0 ? this.maxAgeMinutes * 60_000 : 0
    // Age-shed accounting (#70): shedding is NEVER a silent deletion. Every dropped file's age is collected
    // here and emitted as ONE audit log line (count + age range) on the way out (finally), and counted on
    // QueueStatus.shedFiles — so the operator always sees what freshness cost, distinct from a re-queue.
    const shedAgesMs: number[] = []
    try {
      // Drain until the spool is EMPTY, not just one pass. Chunks appended DURING a drain (a later capture
      // segment, or the second half of a burst) would otherwise sit undrained until the next external
      // trigger — and the distill cadence throttle (#58) now depends on spooled material ACCUMULATING across
      // drains before it releases a distill, so a stranded tail would delay distill indefinitely. Re-reading
      // after each pass lets that accumulation complete inside one idle window. A pass that hit a FAILURE
      // stops the loop: the failed file is re-queued for retry-at-idle, so re-looping would spin on a
      // persistent failure (the original single-pass semantics, preserved for the failing case).
      for (;;) {
        // Freshness-first ordering (#70): order pending files by last-activity time, not by sessionId. A
        // LIVE session drains newest-first (render the present; the stale past backfills at idle or sheds);
        // idle drains oldest-first (FIFO the backlog while nothing new arrives). Recomputed each pass so a
        // session going live mid-drain flips the order, and re-reading the freshness of a re-queued file.
        const ordered = await this.orderedPending() // oldest-first
        if (ordered.length === 0) return
        const live = this.isSessionLive?.() ?? false
        const passFiles = live ? ordered.slice().reverse() : ordered
        const now = Date.now()
        let sawFailure = false
        for (const { file, mtimeMs } of passFiles) {
          const pending = join(this.queueDir, file)
          // Age-shed BEFORE processing: a file older than the freshness horizon is DROPPED, never processed
          // and never re-queued (that is the whole point — a live session must not wait behind it). Claim it
          // under a non-.jsonl name FIRST so that even if the unlink fails the drain-until-empty re-read
          // cannot see it again and spin; then unlink. Composes with failure re-queue: a fresh file that
          // FAILS still re-queues below (its mtime is preserved), and only sheds once it ages past the bar.
          if (maxAgeMs > 0 && now - mtimeMs >= maxAgeMs) {
            const shedding = join(this.queueDir, `${file}.shed`)
            try {
              await rename(pending, shedding)
            } catch {
              continue
            }
            await rm(shedding, { force: true })
            shedAgesMs.push(now - mtimeMs)
            this.shedFiles += 1
            continue
          }
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
              // The drain no longer re-queues SILENTLY (the user's wall): classify why it failed and record
              // it so GET /queue / Status / the Try-it card can surface the real reason. A non-invoke error
              // (undescribable) is still logged and re-queued, just without a class — no false diagnosis.
              const at = new Date().toISOString()
              const failure = this.describeFailure ? await this.describeFailure(error, at) : undefined
              if (failure) this.lastFailure = failure
              logger(
                `queue drain processor failed on ${file}, re-queued: ${failure ? `[${failure.class}] ${failure.hint}` : error instanceof Error ? error.message : String(error)}`,
              )
              await rename(draining, pending).catch(() => undefined)
              sawFailure = true
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
        if (sawFailure) return
      }
    } finally {
      if (shedAgesMs.length > 0) {
        const oldest = fmtAge(Math.max(...shedAgesMs))
        const newest = fmtAge(Math.min(...shedAgesMs))
        logger(
          `queue age-shed (#70): dropped ${shedAgesMs.length} stale file(s) beyond ${this.maxAgeMinutes}m — age ${newest}..${oldest}`,
        )
      }
    }
  }

  /**
   * Pending .jsonl files paired with their last-activity time (fs mtime), ordered OLDEST-first. mtime is
   * the cheap honest freshness signal: append() writes to the live session's own file, so its mtime
   * advances with each capture, while a stalled backlog file keeps its old mtime. A file that vanishes
   * mid-stat (a race with a concurrent rename) is skipped this pass and re-read next — the same tolerance
   * as the rename guard. Ties (fast successive writes at the same ms) break on name for determinism. This
   * replaces the prior sessionId name-sort: ordering is by FRESHNESS now, so the drain can render the
   * present rather than the past (#70).
   */
  private async orderedPending(): Promise<{ file: string; mtimeMs: number }[]> {
    const files = (await readdir(this.queueDir)).filter((file) => file.endsWith('.jsonl'))
    const withTimes: { file: string; mtimeMs: number }[] = []
    for (const file of files) {
      try {
        withTimes.push({ file, mtimeMs: (await stat(join(this.queueDir, file))).mtimeMs })
      } catch {
        // vanished/racing file — skip this pass; the re-read will pick it up if it reappears
      }
    }
    return withTimes.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
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
