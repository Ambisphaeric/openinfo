import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { delimiter, extname, join } from 'node:path'
import type { Endpoint, LocalRuntime } from '@openinfo/contracts'

/**
 * The `local` endpoint kind's runtime lifecycle (ARCHITECTURE §8, slice c — tier zero). The engine
 * SPAWNS and MONITORS a managed model server behind the same Endpoint contract, so invoke/health treat
 * a `local` endpoint like an http one whose lifecycle the engine owns. v0 manages ONE runtime family
 * per slot where it pays: llama.cpp's `llama-server` (OpenAI-compat chat) for llm, whisper.cpp's
 * `whisper-server` for stt. The engine does NOT compile or bundle binaries — it DISCOVERS a usable one
 * (PATH + common Homebrew locations); if absent, the offer says exactly how to get it (an honest
 * affordance, never silent failure). Spawned servers bind localhost. Never crashes the engine.
 */

export type LocalEndpoint = Extract<Endpoint, { kind: 'local' }>

/** Where the runtime is on the readiness/health spectrum — reported honestly by health.ts. */
export type SpawnState = 'stopped' | 'starting' | 'ready' | 'crashed' | 'binary-missing' | 'model-missing' | 'unsupported'

/** How to run one runtime family: which binary, how to invoke it, and the HTTP surface it speaks. */
export interface RuntimeSpec {
  runtime: LocalRuntime
  binaryNames: string[]
  /** the honest "how to get it" line shown when no binary is found (never a silent failure). */
  installHint: string
  /** argv (after the binary) given the resolved model path (or model DIR when multiModel) + the port. */
  args: (modelPath: string, port: number) => string[]
  /** GET path that returns 200 once the model is loaded and serving. */
  healthPath: string
  /** true ⇒ speaks OpenAI-compat /v1/chat/completions (llm invoke reuses the http path). */
  chat?: boolean
  /** set ⇒ transcription POST path (whisper-server is /inference, NOT /v1/audio/transcriptions). */
  transcribePath?: string
  /**
   * A multi-model server (omlx) serves a whole model DIRECTORY at once; `endpoint.model` selects which
   * served model per request, so there is NO single model FILE to resolve, download, or pass as -m. Such
   * a runtime is keyed by its port (one server backs every slot it fills), and readiness/model presence
   * is the server's business, not a file on disk.
   */
  multiModel?: boolean
  /**
   * The fixed port this runtime serves on (omlx :8000). When set, the manager first probes this port and
   * ADOPTS a server already answering there rather than spawn-and-collide — the discover-and-adopt rule.
   */
  defaultPort?: number
  /**
   * true ⇒ the engine NEVER spawns this runtime: it is supervised outside (omlx is managed by oMLX.app +
   * a LaunchAgent, com.openinfo.omlx). `ensureRunning` only ADOPTS a server already answering on
   * defaultPort; if none is, it fails honestly (start it via the app) instead of racing the supervisor.
   */
  adoptOnly?: boolean
}

/**
 * The runtimes v0 manages. llama.cpp binds localhost and serves OpenAI-compat chat at /v1; whisper.cpp
 * serves /inference (with --convert so it accepts webm/opus, not only WAV). mlx/omlx is an Apple-silicon
 * MLX server: OpenAI-compat chat at /v1 on a FIXED port (:8000), serving a whole model directory at once
 * (parakeet for stt, kokoro for tts, LFM/gemma for llm — one server, three slots). It is ADOPT-ONLY:
 * oMLX.app + a LaunchAgent already own its lifecycle, so the engine discovers-and-adopts the running
 * server rather than spawning a rival (the serve args are recorded for the record / a manual start, not
 * run by the engine). The remaining LocalRuntime members (ollama/paddle/coreml) are documented FUTURE
 * runtimes — the CONTRIBUTING "add a fabric runtime" recipe adds a spec here; until then they report
 * `unsupported` gracefully.
 */
export const RUNTIME_SPECS: Partial<Record<LocalRuntime, RuntimeSpec>> = {
  'llama.cpp': {
    runtime: 'llama.cpp',
    binaryNames: ['llama-server'],
    installHint: 'brew install llama.cpp',
    args: (model, port) => ['--host', '127.0.0.1', '--port', String(port), '-m', model, '--no-webui'],
    healthPath: '/health',
    chat: true,
  },
  'whisper.cpp': {
    runtime: 'whisper.cpp',
    binaryNames: ['whisper-server'],
    installHint: 'brew install whisper-cpp',
    args: (model, port) => ['--host', '127.0.0.1', '--port', String(port), '-m', model, '--convert'],
    healthPath: '/health',
    transcribePath: '/inference',
  },
  mlx: {
    runtime: 'mlx',
    binaryNames: ['omlx'],
    installHint: 'omlx is managed by oMLX.app — start it there (or run `omlx start`); it serves OpenAI-compat on :8000',
    // The real serve command, recorded for the record: the engine does NOT run this (adoptOnly) because
    // oMLX.app + the com.openinfo.omlx LaunchAgent own it. modelPath is the model DIRECTORY (multiModel).
    args: (modelDir, port) => ['serve', '--model-dir', modelDir, '--host', '0.0.0.0', '--port', String(port)],
    healthPath: '/health',
    chat: true,
    multiModel: true,
    defaultPort: 8000,
    adoptOnly: true,
  },
}

/** The runtime spec table shape (a partial map — only the managed v0 runtimes are present). */
export type LocalRuntimeSpecs = Partial<Record<LocalRuntime, RuntimeSpec>>

const isWindows = process.platform === 'win32'

/**
 * Additional directories to search beyond PATH. On macOS/Linux these are the common Homebrew/manual
 * install locations; on Windows PATH discovery carries the load (installers put runtimes on PATH), so
 * there is nothing OS-standard to add. (HOME is undefined on Windows, so `homedir()` is used, not
 * `$HOME`, to keep `.local/bin` a real absolute path off darwin/linux.)
 */
const EXTRA_BIN_DIRS = isWindows ? [] : ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin')]

/**
 * The executable name variants to probe for a bare runtime name. On Windows a runtime discovered as
 * `llama-server` is really `llama-server.exe`, so each PATHEXT extension is appended (a name that already
 * carries an extension is left as-is). On POSIX the name is used verbatim.
 */
const candidateNames = (name: string): string[] => {
  if (!isWindows || extname(name)) return [name]
  const exts = (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0)
  return exts.map((e) => name + e)
}

const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Discover a usable binary for a spec on PATH + common install locations. Absolute path, or undefined. */
export const findRuntimeBinary = (spec: RuntimeSpec): string | undefined => {
  const dirs = [...(process.env['PATH'] ?? '').split(delimiter), ...EXTRA_BIN_DIRS].filter((d) => d.length > 0)
  for (const name of spec.binaryNames) {
    for (const dir of dirs) {
      for (const candidateName of candidateNames(name)) {
        const candidate = join(dir, candidateName)
        if (existsSync(candidate) && isExecutable(candidate)) return candidate
      }
    }
  }
  return undefined
}

const freePortDefault = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => (port ? resolve(port) : reject(new Error('could not allocate a free port'))))
    })
  })

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Running {
  /** absent for an ADOPTED external server (omlx) — the engine did not spawn it, so it never kills it. */
  child?: ChildProcess
  port: number
  url: string
  spec: RuntimeSpec
  ready: boolean
  readyAt?: number
  deliberateKill: boolean
  adopted?: boolean
}

export interface LocalRuntimeManagerOptions {
  /** resolve a `local` endpoint's model ref to its on-disk path (via the model store). */
  modelPath: (endpoint: LocalEndpoint) => string | undefined
  /** discover the runtime binary (override in tests to point at a fake server script). */
  findBinary?: (spec: RuntimeSpec) => string | undefined
  /** allocate a free localhost port (override in tests). */
  freePort?: () => Promise<number>
  /** the runtime spec table (override in tests). */
  specs?: Partial<Record<LocalRuntime, RuntimeSpec>>
  log?: (line: string) => void
  /** how long to wait for the child to answer its health path after spawn. */
  readyTimeoutMs?: number
  /** bounded restart-on-crash: after this many fast crashes for a runtime, give up (report crashed). */
  maxRestarts?: number
  /** a runtime that stayed ready at least this long resets its crash counter (a real crash, not a loop). */
  crashResetMs?: number
}

/**
 * Owns the spawned local runtime processes for one engine. `ensureRunning` is idempotent and lazy
 * (spawn on demand — the first invoke/health against a local endpoint, or an explicit warm after a
 * starter-model download); `status` reports the spawn state without spawning (health.ts uses it);
 * `shutdown` kills every child (called on engine close). Restart-on-crash is BOUNDED: after
 * `maxRestarts` fast crashes a runtime reports `crashed` and stops respawning until the engine restarts.
 */
export class LocalRuntimeManager {
  private readonly running = new Map<string, Running>()
  private readonly pending = new Map<string, Promise<{ url: string; spec: RuntimeSpec }>>()
  private readonly crashes = new Map<string, number>()
  private readonly opts: Required<Omit<LocalRuntimeManagerOptions, 'log'>> & { log: (line: string) => void }

  constructor(options: LocalRuntimeManagerOptions) {
    this.opts = {
      modelPath: options.modelPath,
      findBinary: options.findBinary ?? findRuntimeBinary,
      freePort: options.freePort ?? freePortDefault,
      specs: options.specs ?? RUNTIME_SPECS,
      log: options.log ?? (() => undefined),
      readyTimeoutMs: options.readyTimeoutMs ?? 120_000,
      maxRestarts: options.maxRestarts ?? 3,
      crashResetMs: options.crashResetMs ?? 30_000,
    }
  }

  private keyOf(endpoint: LocalEndpoint): string {
    const spec = this.specFor(endpoint)
    // A multi-model server backs every slot from ONE process on its port, so all its endpoints share
    // one key (adopt/spawn once, not once per model). Single-model runtimes key by model as before.
    if (spec?.multiModel) return `${endpoint.runtime}::${spec.defaultPort ?? 'port'}`
    return `${endpoint.runtime}::${endpoint.model}`
  }

  /** The runtime spec for a local endpoint, or undefined when the runtime is not managed in v0. */
  specFor(endpoint: LocalEndpoint): RuntimeSpec | undefined {
    return this.opts.specs[endpoint.runtime]
  }

  /** Report the spawn state without spawning — for honest health (binary/model/starting/ready/crashed). */
  status(endpoint: LocalEndpoint): SpawnState {
    const spec = this.specFor(endpoint)
    if (!spec) return 'unsupported'
    const key = this.keyOf(endpoint)
    const running = this.running.get(key)
    if (running) return running.ready ? 'ready' : 'starting'
    if (this.pending.has(key)) return 'starting'
    // An adopt-only runtime (omlx) is not spawned, so there is no binary/model/crash story to report
    // synchronously — liveness is a live probe (checkEndpoint does it) or the adopted entry above.
    // Un-adopted here means "not yet adopted"; report `stopped` (adopts on demand at first invoke).
    if (spec.adoptOnly) return 'stopped'
    if ((this.crashes.get(key) ?? 0) >= this.opts.maxRestarts) return 'crashed'
    if (!this.opts.findBinary(spec)) return 'binary-missing'
    if (!spec.multiModel) {
      const model = this.opts.modelPath(endpoint)
      if (!model || !existsSync(model)) return 'model-missing'
    }
    return 'stopped'
  }

  /**
   * Ensure the runtime for this endpoint is spawned and serving; returns its localhost url + spec.
   * Idempotent (a ready runtime is returned immediately; a concurrent start is shared). Throws — never
   * crashes the engine — when the binary is missing, the model file is absent, the crash budget is spent,
   * or readiness times out; the invoke/health caller catches it and falls through in fabric order.
   */
  async ensureRunning(endpoint: LocalEndpoint): Promise<{ url: string; spec: RuntimeSpec }> {
    const spec = this.specFor(endpoint)
    if (!spec) throw new Error(`unsupported local runtime "${endpoint.runtime}"`)
    const key = this.keyOf(endpoint)
    const existing = this.running.get(key)
    if (existing?.ready) return { url: existing.url, spec }
    const inflight = this.pending.get(key)
    if (inflight) return inflight
    const started = this.start(endpoint, spec, key).finally(() => this.pending.delete(key))
    this.pending.set(key, started)
    return started
  }

  /**
   * Is a server ANSWERING on this health url? Any HTTP reply — including 401/403 — means "present"
   * (omlx's /health is open, but an authed /health would still prove the process is up); only a
   * transport failure (nothing listening) means absent. Never throws.
   */
  private async isServerUp(url: string): Promise<boolean> {
    try {
      await fetch(url, { signal: AbortSignal.timeout(2_000) })
      return true // it answered (2xx/4xx/5xx all prove a live listener)
    } catch {
      return false // connection refused / DNS / timeout — nothing there
    }
  }

  /**
   * Adopt an externally-managed server already answering on its fixed port (omlx). Discover-and-adopt,
   * never spawn-and-collide: this records the running server WITHOUT a child process (so shutdown never
   * kills the supervisor's process), or fails honestly when nothing is listening — the user starts it
   * via oMLX.app / `omlx start` rather than the engine racing the LaunchAgent for the port.
   */
  private async adopt(endpoint: LocalEndpoint, spec: RuntimeSpec, key: string): Promise<{ url: string; spec: RuntimeSpec }> {
    const port = spec.defaultPort
    if (port === undefined) throw new Error(`${spec.runtime} is adopt-only but declares no defaultPort`)
    const url = `http://127.0.0.1:${port}`
    if (!(await this.isServerUp(`${url}${spec.healthPath}`))) {
      throw new Error(`${spec.runtime} is not running on :${port} — ${spec.installHint}`)
    }
    const entry: Running = { port, url, spec, ready: true, readyAt: Date.now(), deliberateKill: false, adopted: true }
    this.running.set(key, entry)
    this.opts.log(`adopted external ${spec.runtime} runtime for ${endpoint.name} on ${url} (managed outside the engine)`)
    return { url, spec }
  }

  private async start(endpoint: LocalEndpoint, spec: RuntimeSpec, key: string): Promise<{ url: string; spec: RuntimeSpec }> {
    // Discover-and-adopt: a runtime supervised outside the engine (omlx) is never spawned — adopt the
    // running server on its fixed port, or fail honestly. No crash budget (we did not start it).
    if (spec.adoptOnly) return this.adopt(endpoint, spec, key)
    if (spec.multiModel) throw new Error(`multi-model runtime "${spec.runtime}" is adopt-only in v0 (no managed spawn)`)
    if ((this.crashes.get(key) ?? 0) >= this.opts.maxRestarts) {
      throw new Error(`local runtime "${endpoint.name}" crashed ${this.opts.maxRestarts}× — not restarting (restart the engine)`)
    }
    const binary = this.opts.findBinary(spec)
    if (!binary) throw new Error(`${spec.runtime} binary not found — ${spec.installHint}`)
    const modelPath = this.opts.modelPath(endpoint)
    if (!modelPath || !existsSync(modelPath)) throw new Error(`model file for "${endpoint.model}" not downloaded yet`)

    const port = await this.opts.freePort()
    const url = `http://127.0.0.1:${port}`
    const child = spawn(binary, spec.args(modelPath, port), { stdio: ['ignore', 'pipe', 'pipe'] })
    const entry: Running = { child, port, url, spec, ready: false, deliberateKill: false }
    this.running.set(key, entry)
    let lastErr = ''
    child.stderr?.on('data', (b: Buffer) => {
      lastErr = b.toString('utf8').trim().split('\n').pop() ?? lastErr
    })
    child.on('exit', (code, signal) => {
      const cur = this.running.get(key)
      if (cur === entry) this.running.delete(key)
      if (entry.deliberateKill) {
        this.opts.log(`local runtime ${endpoint.name} (${spec.runtime}) stopped`)
        return
      }
      const stayedHealthy = entry.readyAt !== undefined && Date.now() - entry.readyAt > this.opts.crashResetMs
      const count = stayedHealthy ? 1 : (this.crashes.get(key) ?? 0) + 1
      this.crashes.set(key, count)
      this.opts.log(
        `local runtime ${endpoint.name} (${spec.runtime}) exited unexpectedly (code ${code ?? '-'}, signal ${signal ?? '-'}) — crash ${count}/${this.opts.maxRestarts}${lastErr ? `: ${lastErr}` : ''}`,
      )
    })

    this.opts.log(`spawning local runtime ${endpoint.name} (${spec.runtime}) on ${url} — ${binary}`)
    try {
      await this.waitReady(entry)
    } catch (error) {
      const alreadyExited = child.exitCode !== null || child.signalCode !== null
      if (alreadyExited) {
        // It crashed before ready — the exit handler already counted it; just clean up.
        this.running.delete(key)
      } else {
        // Alive but never answered health (a hang) — deliberately kill it. The exit handler skips
        // deliberate kills, so count this timeout here to keep restart bounded either way.
        entry.deliberateKill = true
        child.kill('SIGKILL')
        this.running.delete(key)
        this.crashes.set(key, (this.crashes.get(key) ?? 0) + 1)
      }
      throw new Error(`${endpoint.name} did not become ready: ${error instanceof Error ? error.message : String(error)}${lastErr ? ` (${lastErr})` : ''}`)
    }
    entry.ready = true
    entry.readyAt = Date.now()
    this.crashes.set(key, 0)
    this.opts.log(`local runtime ${endpoint.name} (${spec.runtime}) ready on ${url}`)
    return { url, spec }
  }

  private async waitReady(entry: Running): Promise<void> {
    const deadline = Date.now() + this.opts.readyTimeoutMs
    while (Date.now() < deadline) {
      // waitReady only runs for a spawned entry (child present); adopted servers never reach here.
      if (entry.child && (entry.child.exitCode !== null || entry.child.signalCode !== null)) throw new Error('runtime exited before ready')
      try {
        const res = await fetch(`${entry.url}${entry.spec.healthPath}`, { signal: AbortSignal.timeout(1_000) })
        if (res.ok) return
      } catch {
        // not up yet — keep polling
      }
      await sleep(200)
    }
    throw new Error(`no health response within ${this.opts.readyTimeoutMs}ms`)
  }

  /**
   * Kill every SPAWNED child — called on engine shutdown. Deliberate kills are not counted as crashes.
   * Adopted external servers (omlx) have no child and are left running: the engine never spawned them,
   * so it never stops them (oMLX.app + the LaunchAgent own that lifecycle).
   */
  shutdown(): void {
    for (const [, entry] of this.running) {
      if (!entry.child) continue // adopted external server — not ours to kill
      entry.deliberateKill = true
      entry.child.kill('SIGTERM')
    }
    this.running.clear()
    this.pending.clear()
  }
}
