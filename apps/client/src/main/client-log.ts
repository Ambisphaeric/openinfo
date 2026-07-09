import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * A tiny, dependency-free rotating log file for the packaged client.
 *
 * WHY this exists (issue #41): the packaged .app has no terminal, so every `console.*` in the shell and
 * capture paths goes to a lost stdout — the whole capture-failure class (dropped start, renderer gone,
 * permission denied) was INVISIBLE in the field. This gives those lines a durable home on disk while
 * still mirroring to the console for a dev run.
 *
 * Deliberately minimal: a single append with a size cap and ONE backup file (`client.log` →
 * `client.log.1` on rollover), no timers, no external deps. Best-effort throughout — a logging failure
 * must NEVER take down capture or the shell, so every fs edge is swallowed. Pure enough to test against
 * a temp dir (the fs calls are the only side effect; the rotation decision is asserted headless).
 */

export interface ClientLog {
  (message: string): void
}

export interface ClientLogOptions {
  /** Absolute path of the active log file (its parent dir is created if missing). */
  file: string
  /** Roll over to `<file>.1` once the active file would exceed this many bytes. Default 512 KiB. */
  maxBytes?: number
  /** Also echo each line here (defaults to console.log) — keeps a dev run's stdout intact. */
  mirror?: (line: string) => void
  /** Clock seam so the timestamp prefix is assertable in tests. Defaults to Date.now via new Date(). */
  now?: () => Date
}

const DEFAULT_MAX_BYTES = 512 * 1024

/** Current size of `file` in bytes, or 0 if it does not exist yet (or is unreadable). */
const sizeOf = (file: string): number => {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

/**
 * Build an append-only rotating logger. Each call writes one `ISO<space>message` line. When the active
 * file would cross `maxBytes`, it is renamed to `<file>.1` (replacing any previous backup) and a fresh
 * active file begins — so on-disk usage is bounded at ~2×maxBytes. Never throws.
 */
export const createClientLog = (options: ClientLogOptions): ClientLog => {
  const maxBytes = options.maxBytes && options.maxBytes > 0 ? options.maxBytes : DEFAULT_MAX_BYTES
  const mirror = options.mirror ?? ((line: string) => console.log(line))
  const now = options.now ?? (() => new Date())
  const backup = `${options.file}.1`
  let dirReady = false

  const ensureDir = (): void => {
    if (dirReady) return
    try {
      mkdirSync(path.dirname(options.file), { recursive: true })
    } catch {
      /* best-effort — a write failure below just degrades to console-only */
    }
    dirReady = true
  }

  return (message: string): void => {
    const line = `${now().toISOString()} ${message}`
    mirror(line)
    try {
      ensureDir()
      const entry = `${line}\n`
      if (sizeOf(options.file) + Buffer.byteLength(entry) > maxBytes) {
        try {
          renameSync(options.file, backup) // replaces any existing .1 atomically
        } catch {
          /* nothing to roll (first write) or rename raced — write into the active file anyway */
        }
      }
      appendFileSync(options.file, entry)
    } catch {
      /* disk full / permissions — the console mirror already carried the line; never crash capture */
    }
  }
}
