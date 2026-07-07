import { appendFile, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { CaptureChunk, QueueStatus } from '@openinfo/contracts'

const safeName = (value: string): string => value.replace(/[^a-zA-Z0-9._-]/g, '_')

/**
 * Invoked once per drained file with its parsed chunks (the distiller's seam — see PHASE2-NOTES).
 * If it throws, the file is returned to the pending path so capture is never lost (retry-at-idle).
 * When no processor is supplied the drain is a no-op that GCs drained files (Phase 1 behavior).
 */
export type DrainProcessor = (chunks: CaptureChunk[]) => Promise<void>

export class CaptureQueue {
  private drainedFiles = 0
  private draining = false

  constructor(
    private readonly queueDir: string,
    private readonly processor?: DrainProcessor,
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
          logger(`queue drain processor failed on ${file}, re-queued: ${error instanceof Error ? error.message : String(error)}`)
          await rename(draining, pending).catch(() => undefined)
          continue
        }
      } else {
        logger(`queue drain no-op processed ${file}`)
      }
      await rm(draining, { force: true })
      this.drainedFiles += 1
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
