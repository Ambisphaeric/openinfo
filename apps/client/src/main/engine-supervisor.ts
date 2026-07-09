import path from 'node:path'

/**
 * The engine-spawn DECISION + its plumbing helpers, kept PURE so the "adopt vs spawn vs unreachable" policy
 * is asserted headless (shell.ts wires the electron `utilityProcess` around it — the only electron edge).
 *
 * The client is a pure HTTP/WS client to an engine URL (env > ~/.openinfo/client.json > 127.0.0.1:8787).
 * Historically a double-clicked .app had nothing to talk to. This module decides, ONCE at startup, whether
 * an engine is ALREADY answering the health check — then ADOPT it, spawn nothing, and never kill a process
 * we didn't start (the dev-rig case: the owner runs an engine on :8787) — or whether to spawn the engine we
 * bundled inside the app as a resource. If neither (unreachable + no bundle), the tray's existing
 * "engine unreachable" leading state stands, unchanged: the seam degrades, it never masks failure.
 */

export type EngineDisposition = 'adopt' | 'spawn' | 'unreachable'

/**
 * - `adopt`: an engine already answers → do nothing, talk to it (never collide, never kill it on quit).
 * - `spawn`: nothing answers AND we shipped a bundled engine → spawn that child (and own its lifecycle).
 * - `unreachable`: nothing answers and there is no bundle → the tray leads with the unreachable state.
 */
export const decideEngineDisposition = (opts: { reachable: boolean; bundledEnginePresent: boolean }): EngineDisposition =>
  opts.reachable ? 'adopt' : opts.bundledEnginePresent ? 'spawn' : 'unreachable'

/** Minimal fetch shape — injectable so the health check is tested with no network and no display. */
export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean }>

/**
 * Fast liveness probe: GET `${engineUrl}/health` under a short abort timeout. True iff it answers ok; ANY
 * error (connection refused, timeout, non-2xx) ⇒ false, i.e. "no engine here". The timeout matters because
 * a refused loopback connection fails instantly but a black-holed host could otherwise stall app start.
 */
export const checkEngineReachable = async (
  engineUrl: string,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<boolean> => {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const timeoutMs = opts.timeoutMs ?? 1500
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`${engineUrl.replace(/\/+$/, '')}/health`, { signal: controller.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Poll the health check until it answers or the budget runs out — used AFTER a spawn to know the child is
 * actually serving (a fresh engine cold-starts its store/DB before it listens). Resolves true on the first
 * ok, false if the whole budget elapses. Kept pure over an injected sleeper + fetch so it is deterministic
 * in tests (no real timers, no real network).
 */
export const waitForEngine = async (
  engineUrl: string,
  opts: {
    fetchImpl?: FetchLike
    attempts?: number
    intervalMs?: number
    perCheckTimeoutMs?: number
    sleep?: (ms: number) => Promise<void>
  } = {},
): Promise<boolean> => {
  const attempts = opts.attempts ?? 40
  const intervalMs = opts.intervalMs ?? 250
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const checkOpts: { fetchImpl?: FetchLike; timeoutMs: number } = { timeoutMs: opts.perCheckTimeoutMs ?? 1000 }
  if (opts.fetchImpl) checkOpts.fetchImpl = opts.fetchImpl
  for (let i = 0; i < attempts; i++) {
    if (await checkEngineReachable(engineUrl, checkOpts)) return true
    if (i < attempts - 1) await sleep(intervalMs)
  }
  return false
}

/**
 * Where the bundled engine's entry lives inside the packaged app, given Electron's `process.resourcesPath`.
 * package.mjs stages the engine as a REPO-SHAPED `engine-bundle/` extraResource — `apps/engine/dist` + a
 * hoisted (symlink-free) prod `node_modules` with better-sqlite3 rebuilt for Electron's ABI + a
 * `shared/contracts/examples/` copy — so the engine's compiled, repo-relative data-file paths
 * (`dist/api → ../../../../shared/contracts/examples`) resolve UNCHANGED. The engine source is consumed
 * as-is, never patched; the bundle just reproduces the layout those paths already expect.
 */
export const bundledEngineEntry = (resourcesPath: string): string =>
  path.join(resourcesPath, 'engine-bundle', 'apps', 'engine', 'dist', 'main.js')

/**
 * The port a spawned engine must listen on — parsed from the configured engineUrl so the client talks to
 * its child at the same URL it health-checked. Falls back to the engine's own default (8787) when the URL
 * carries no explicit port or cannot be parsed. (Spawn only fires for the loopback default in practice; a
 * remote/portless engineUrl means an engine the user runs elsewhere, which the health check adopts.)
 */
export const portFromEngineUrl = (engineUrl: string): number => {
  try {
    const parsed = new URL(engineUrl)
    return parsed.port ? Number(parsed.port) : 8787
  } catch {
    return 8787
  }
}
