import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { LocalModelStatus, LocalRuntime, StarterModel } from '@openinfo/contracts'
import { RUNTIME_SPECS, findRuntimeBinary, type LocalEndpoint, type RuntimeSpec } from './endpoints/local.js'

/**
 * Model acquisition for tier zero (ARCHITECTURE §8, slice c). Downloads a vetted starter model into the
 * data root `models/` dir with RESUME support, progress reporting, and a size sanity check, then the
 * runtime manager can spawn against it. NEVER auto-downloads — a starter model is fetched only on an
 * explicit user click (POST /fabric/local/download). The download runs in the background; progress is
 * read by polling `statuses()` (the smallest honest mechanism — no new WS event type).
 */

export interface DownloadProgress {
  downloadedBytes: number
  totalBytes?: number
}

/** A truncated/HTML-error-page guard: a real model file is far larger than this. */
const MIN_PLAUSIBLE_BYTES = 100_000

/**
 * Download `url` to `dest` with resume + progress + a size/integrity check. Resumes from a `.part` file
 * via a Range request (falls back to a fresh download if the server ignores the range); renames to
 * `dest` only after the size check (and sha256, when given) passes. Standalone + testable against a
 * local http server. Throws on any failure so the caller records an honest error state.
 */
export const downloadModel = async (
  url: string,
  dest: string,
  opts: { onProgress?: (p: DownloadProgress) => void; expectedSha256?: string; minBytes?: number } = {},
): Promise<{ bytes: number; totalBytes?: number }> => {
  await mkdir(join(dest, '..'), { recursive: true })
  const part = `${dest}.part`
  let from = existsSync(part) ? statSync(part).size : 0
  const headers: Record<string, string> = from > 0 ? { Range: `bytes=${from}-` } : {}
  const res = await fetch(url, { headers, redirect: 'follow' })

  if (res.status === 416) {
    // Range not satisfiable — the .part is already the full file. Verify + promote.
    return finalize(part, dest, from, from, opts)
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`)
  if (!res.body) throw new Error('no response body')

  // Server honored the range (206) ⇒ append; ignored it (200) ⇒ restart from zero.
  const resumed = res.status === 206 && from > 0
  if (!resumed) from = 0
  const contentLength = Number(res.headers.get('content-length') ?? '')
  const totalBytes = resumed
    ? parseContentRangeTotal(res.headers.get('content-range')) ?? (Number.isFinite(contentLength) ? from + contentLength : undefined)
    : Number.isFinite(contentLength) && contentLength > 0
      ? contentLength
      : undefined

  const sink = createWriteStream(part, { flags: resumed ? 'a' : 'w' })
  let downloaded = from
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      downloaded += chunk.byteLength
      if (!sink.write(chunk)) await new Promise<void>((r) => sink.once('drain', () => r()))
      opts.onProgress?.({ downloadedBytes: downloaded, ...(totalBytes !== undefined ? { totalBytes } : {}) })
    }
  } finally {
    await new Promise<void>((resolve, reject) => sink.end((err?: Error | null) => (err ? reject(err) : resolve())))
  }
  return finalize(part, dest, downloaded, totalBytes, opts)
}

const finalize = async (
  part: string,
  dest: string,
  downloaded: number,
  totalBytes: number | undefined,
  opts: { expectedSha256?: string; minBytes?: number },
): Promise<{ bytes: number; totalBytes?: number }> => {
  const onDisk = existsSync(part) ? (await stat(part)).size : 0
  const floor = opts.minBytes ?? MIN_PLAUSIBLE_BYTES
  const fail = async (message: string): Promise<never> => {
    await rm(part, { force: true })
    throw new Error(message)
  }
  if (onDisk < floor) return fail(`downloaded file is implausibly small (${onDisk} bytes) — likely an error page, discarded`)
  if (totalBytes !== undefined && onDisk !== totalBytes) return fail(`size mismatch: expected ${totalBytes} bytes, got ${onDisk}`)
  if (opts.expectedSha256) {
    const actual = await sha256File(part)
    if (actual !== opts.expectedSha256.toLowerCase()) return fail(`sha256 mismatch (expected ${opts.expectedSha256})`)
  }
  await rename(part, dest)
  return { bytes: onDisk, ...(totalBytes !== undefined ? { totalBytes } : {}) }
}

const parseContentRangeTotal = (header: string | null): number | undefined => {
  const total = header?.match(/\/(\d+)\s*$/)?.[1]
  return total ? Number(total) : undefined
}

const sha256File = async (path: string): Promise<string> => {
  const { createReadStream } = await import('node:fs')
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const s = createReadStream(path)
    s.on('data', (c) => hash.update(c))
    s.on('end', () => resolve())
    s.on('error', reject)
  })
  return hash.digest('hex')
}

interface Task {
  downloadedBytes: number
  totalBytes?: number
  error?: string
  promise: Promise<void>
}

/**
 * The engine's view of the starter-model catalog + local state. Joins each catalog entry with what the
 * engine can see: whether the runtime binary is present (with an install hint when not), and whether the
 * file is downloaded / downloading / absent (+ progress). `resolvePath` maps a local endpoint's `model`
 * ref (a StarterModel id or a bare filename) to its on-disk path for the runtime manager.
 */
export class LocalModelStore {
  private readonly tasks = new Map<string, Task>()
  /** Runtime discovery, injectable for tests/e2e — mirrors LocalRuntimeManager's seam so ONE injected
   *  resolver governs both what spawns AND what the Get-Started lens reports as available (no real PATH
   *  lookup leaks in). Unset in production ⇒ real binary discovery on PATH + Homebrew locations. */
  private readonly findBinary: (spec: RuntimeSpec) => string | undefined
  private readonly specs: Partial<Record<LocalRuntime, RuntimeSpec>>

  constructor(
    private readonly modelsDir: string,
    private readonly catalog: () => StarterModel[],
    runtime: { findBinary?: (spec: RuntimeSpec) => string | undefined; specs?: Partial<Record<LocalRuntime, RuntimeSpec>> } = {},
  ) {
    this.findBinary = runtime.findBinary ?? findRuntimeBinary
    this.specs = runtime.specs ?? RUNTIME_SPECS
  }

  pathFor(model: StarterModel): string {
    return join(this.modelsDir, model.filename)
  }

  /** Resolve a local endpoint's `model` (a StarterModel id or a bare filename) to an on-disk path. */
  resolvePath(endpoint: LocalEndpoint): string | undefined {
    const byId = this.catalog().find((m) => m.id === endpoint.model)
    const candidate = byId ? this.pathFor(byId) : join(this.modelsDir, endpoint.model)
    return existsSync(candidate) ? candidate : undefined
  }

  private runtimeAvailable(model: StarterModel): boolean {
    const spec = this.specs[model.runtime]
    return spec ? this.findBinary(spec) !== undefined : false
  }

  private statusFor(model: StarterModel): LocalModelStatus {
    const available = this.runtimeAvailable(model)
    const base: LocalModelStatus = {
      model,
      runtimeAvailable: available,
      state: 'absent',
    }
    const hint = this.specs[model.runtime]?.installHint
    if (!available && hint) base.installHint = hint
    const task = this.tasks.get(model.id)
    if (existsSync(this.pathFor(model))) return { ...base, state: 'ready' }
    if (task?.error) return { ...base, state: 'error', error: task.error, downloadedBytes: task.downloadedBytes }
    if (task) {
      return {
        ...base,
        state: 'downloading',
        downloadedBytes: task.downloadedBytes,
        ...(task.totalBytes !== undefined ? { totalBytes: task.totalBytes } : {}),
      }
    }
    return base
  }

  /** Every catalog model joined with its local state — what the Get-Started lens renders + polls. */
  statuses(): LocalModelStatus[] {
    return this.catalog().map((model) => this.statusFor(model))
  }

  /**
   * Begin downloading a model (explicit click only). Idempotent while in flight or already ready.
   * Returns the current status immediately; the download runs in the background (poll statuses()).
   * Unknown id ⇒ undefined (the route 404s).
   */
  download(modelId: string): LocalModelStatus | undefined {
    const model = this.catalog().find((m) => m.id === modelId)
    if (!model) return undefined
    if (existsSync(this.pathFor(model))) return this.statusFor(model)
    const existing = this.tasks.get(modelId)
    if (existing && !existing.error) return this.statusFor(model)

    const task: Task = { downloadedBytes: 0, promise: Promise.resolve() }
    task.promise = downloadModel(model.url, this.pathFor(model), {
      onProgress: (p) => {
        task.downloadedBytes = p.downloadedBytes
        if (p.totalBytes !== undefined) task.totalBytes = p.totalBytes
      },
      ...(model.sha256 !== undefined ? { expectedSha256: model.sha256 } : {}),
    })
      .then(() => {
        this.tasks.delete(modelId) // file now on disk ⇒ statusFor reads 'ready'
      })
      .catch((error: unknown) => {
        task.error = error instanceof Error ? error.message : String(error)
      })
    this.tasks.set(modelId, task)
    return this.statusFor(model)
  }

  /** Await the in-flight download for a model (tests). No-op if none is running. */
  async settle(modelId: string): Promise<void> {
    await this.tasks.get(modelId)?.promise
  }
}
