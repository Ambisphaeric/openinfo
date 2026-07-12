import { readFileSync } from 'node:fs'
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

/** Fetch shape for reading the health BODY (version handshake) — injectable for a no-network test. */
export type HealthFetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>

/** The subset of the engine's /health payload the client reads for the version handshake. */
export interface EngineHealth {
  version?: string
  build?: string
}

/**
 * Read the engine's /health body for its version + build (the handshake). Best-effort and additive: a
 * non-ok response, a network error, or an engine too old to report a version all resolve to `{}` — the
 * caller renders "version unknown", which is itself the honest signal. Never throws.
 */
export const fetchEngineHealth = async (
  engineUrl: string,
  opts: { fetchImpl?: HealthFetchLike; timeoutMs?: number } = {},
): Promise<EngineHealth> => {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as HealthFetchLike)
  const timeoutMs = opts.timeoutMs ?? 1500
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`${engineUrl.replace(/\/+$/, '')}/health`, { signal: controller.signal })
    if (!res.ok) return {}
    const body = (await res.json()) as EngineHealth | null
    const out: EngineHealth = {}
    if (body && typeof body.version === 'string') out.version = body.version
    if (body && typeof body.build === 'string') out.build = body.build
    return out
  } catch {
    return {}
  } finally {
    clearTimeout(timer)
  }
}

/** Parse a dotted numeric version ("0.0.1" / "1.2") into a comparable tuple; undefined if unparseable. */
const parseVersion = (v: string): number[] | undefined => {
  const core = v.trim().split(/[-+]/, 1)[0] ?? '' // drop any prerelease/build suffix before comparing
  const parts = core.split('.').map((p) => Number(p))
  if (parts.length === 0 || parts.some((n) => !Number.isFinite(n))) return undefined
  return parts
}

/**
 * Compare two dotted versions: -1 (a<b), 0 (equal), 1 (a>b), or undefined when either is unparseable.
 * Missing trailing segments read as 0 ("0.0" == "0.0.0"), so a version bump in any position is caught.
 */
export const compareVersions = (a: string, b: string): -1 | 0 | 1 | undefined => {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return undefined
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da < db) return -1
    if (da > db) return 1
  }
  return 0
}

/** What the client captured about the engine it is talking to — the disposition + the adopted/spawned version. */
export interface EngineVersionInfo {
  disposition: EngineDisposition
  engineVersion?: string
  build?: string
  /** the client's OWN app version, so skew is expressed relative to it. */
  appVersion?: string
  /** the engine URL, so an adopted engine's port can be shown ("adopted at :8787"). */
  engineUrl?: string
}

/** ":8787"-style suffix parsed from the engine URL for the adopted-at line; '' when no explicit port. */
const portSuffix = (engineUrl: string | undefined): string => {
  if (engineUrl === undefined) return ''
  try {
    const port = new URL(engineUrl).port
    return port ? ` at :${port}` : ''
  } catch {
    return ''
  }
}

/**
 * The one-line engine-status affordance the client surfaces (tray). Examples:
 *   "engine v0.0.1 · adopted at :8787"
 *   "engine v0.0.1 · spawned (bundled) · build a1b2c3d"
 *   "engine v0.0.1 · adopted at :8787 · build a1b2c3d · older than this app (v0.0.2)"   ← skew made plain
 *   "engine version unknown · adopted at :8787 · predates this app's version reporting"
 * The optional `build` id (a git short sha the packaged/deployed engine stamps into /health via
 * OPENINFO_BUILD) is surfaced right after the location — two builds of the SAME version are otherwise
 * indistinguishable, which is exactly the stale-adoption failure this line exists to make visible. It
 * used to be dropped on the floor here even when /health reported it.
 * Returns undefined for `unreachable` — the tray already LEADS with its own unreachable state, so this
 * line would be redundant noise there.
 */
export const engineStatusLine = (info: EngineVersionInfo): string | undefined => {
  if (info.disposition === 'unreachable') return undefined
  const where = info.disposition === 'adopt' ? `adopted${portSuffix(info.engineUrl)}` : 'spawned (bundled)'
  const version = info.engineVersion ? `engine v${info.engineVersion}` : 'engine version unknown'
  const parts = [version, where]
  if (info.build !== undefined && info.build.trim() !== '') parts.push(`build ${info.build.trim()}`)
  const skew = versionSkewNote(info.disposition, info.engineVersion, info.appVersion)
  if (skew !== undefined) parts.push(skew)
  return parts.join(' · ')
}

/**
 * The plain-language skew note when the engine's version differs from the app's own — or is absent
 * (an engine predating the handshake, which the client treats as "older"). Undefined when they match,
 * when the app version is unknown, or when the versions can't be compared (nothing honest to say).
 */
const versionSkewNote = (
  disposition: EngineDisposition,
  engineVersion: string | undefined,
  appVersion: string | undefined,
): string | undefined => {
  if (appVersion === undefined) return undefined
  if (engineVersion === undefined) {
    // Only meaningful for an ADOPTED engine — a spawned bundled engine is this app's own build.
    return disposition === 'adopt' ? "predates this app's version reporting" : undefined
  }
  const cmp = compareVersions(engineVersion, appVersion)
  if (cmp === undefined || cmp === 0) return undefined
  return cmp < 0 ? `older than this app (v${appVersion})` : `newer than this app (v${appVersion})`
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

// ── Skew refusal (S6) ────────────────────────────────────────────────────────────────────────────────
// Adopting ANY reachable engine was silent: a stale launchd/dev engine (an older version, or the SAME
// version built from different source) was adopted with no signal beyond a disabled tray line. That is
// how the owner's QA round ran a client against a mismatched engine without noticing. The client now
// ASSESSES an adopted engine's version/build against its own and, on a mismatch, REFUSES it by default —
// the shell surfaces a blocking banner instead of quietly talking to the wrong engine. A dev flag
// (OPENINFO_ALLOW_ENGINE_SKEW) opts back into adoption, because a dev deliberately runs mismatched pairs.

/** Inputs to the skew assessment — the adopted engine's reported identity vs. this app's own. */
export interface SkewInput {
  /** the app's own version (app.getVersion()) — the reference point. When absent we cannot honestly judge. */
  appVersion?: string
  /** the app's own build id (git short sha stamped into the package), when this is a stamped build. */
  appBuild?: string
  /** the engine's /health version (undefined ⇒ an engine predating the version field — treated as skew). */
  engineVersion?: string
  /** the engine's /health build id, when it stamped one. */
  engineBuild?: string
  /** the dev opt-in: a mismatch is ADOPTED anyway (with a warning) rather than refused. */
  allowSkew: boolean
}

/** The verdict: whether to adopt, whether the refusal was a skew refusal, and the plain-language reason. */
export interface SkewVerdict {
  /** proceed to talk to this engine (true when there is no skew, or skew is dev-allowed). */
  adopt: boolean
  /** a version/build mismatch was detected at all (independent of whether it was overridden). */
  skewed: boolean
  /** the mismatch was detected AND not dev-allowed ⇒ the engine is refused. */
  refused: boolean
  /** plain-language mismatch explanation — present whenever `skewed`, for the banner + tray + log. */
  reason?: string
}

/**
 * Assess an ADOPTED engine's identity against this app's own — the pure heart of skew refusal, tested
 * headless. Skew is: a parseably-different version; an engine that reports NO version (predates the field,
 * so it is by definition an old build); or the SAME version stamped with a different build id. No skew ⇒
 * adopt. Skew + `allowSkew` ⇒ adopt with the reason retained (the caller logs a warning). Skew + no flag ⇒
 * refused. When the app's OWN version is unknown we cannot honestly refuse (nothing to compare) ⇒ adopt.
 * Only meaningful for the `adopt` disposition — a spawned bundled engine IS this app's build, and an
 * unreachable one is nothing to assess.
 */
export const assessEngineSkew = (input: SkewInput): SkewVerdict => {
  const noSkew: SkewVerdict = { adopt: true, skewed: false, refused: false }
  if (input.appVersion === undefined) return noSkew // can't compare against an unknown self — don't fabricate a refusal
  let reason: string | undefined
  if (input.engineVersion === undefined) {
    reason = `the engine predates version reporting (this app is v${input.appVersion})`
  } else {
    const cmp = compareVersions(input.engineVersion, input.appVersion)
    if (cmp === -1) reason = `engine v${input.engineVersion} is older than this app (v${input.appVersion})`
    else if (cmp === 1) reason = `engine v${input.engineVersion} is newer than this app (v${input.appVersion})`
    else if (cmp === undefined) reason = `engine version "${input.engineVersion}" is not comparable to this app (v${input.appVersion})`
    else if (buildsDiffer(input.engineBuild, input.appBuild)) {
      // Same version, different build: two engines both self-reporting v0.0.11 but built from different
      // source — the exact case a version-only check misses. Only asserted when BOTH stamp a build.
      reason = `engine and app are both v${input.appVersion} but built from different sources (engine build ${input.engineBuild}, app build ${input.appBuild})`
    }
  }
  if (reason === undefined) return noSkew
  return input.allowSkew
    ? { adopt: true, skewed: true, refused: false, reason }
    : { adopt: false, skewed: true, refused: true, reason }
}

/** Two builds "differ" only when both are present and unequal — a missing stamp is not evidence of skew. */
const buildsDiffer = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && a.trim() !== '' && b.trim() !== '' && a.trim() !== b.trim()

/** The dev opt-in token parse (opt-IN like OPENINFO_SCREEN): only an explicit truthy token allows skew. */
export const parseAllowSkew = (raw: string | undefined): boolean =>
  raw !== undefined && ['1', 'true', 'on', 'yes'].includes(raw.trim().toLowerCase())

// ── Build stamp (S6) ─────────────────────────────────────────────────────────────────────────────────
// A packaged app inherits NO env, so OPENINFO_BUILD (the git short sha) can't reach the spawned engine or
// the client's own version surface that way. package.mjs writes the sha into a `build-stamp.json` beside
// the app's other resources; the shell reads it at startup, shows it, and forwards it to the engine it
// spawns as OPENINFO_BUILD (so /health echoes the same sha). Undefined in a dev run (no packaged resources).

/** The build-stamp file path inside the packaged app's resources (Electron's `process.resourcesPath`). */
export const buildStampPath = (resourcesPath: string): string => path.join(resourcesPath, 'build-stamp.json')

/**
 * Read the packaged build stamp (`{ build }`) from resources — the client's own build id. Best-effort and
 * additive: an absent/unreadable/malformed file (every dev run) resolves to `undefined`, never throws.
 * `readFileImpl` is injectable so the plumbing is asserted headless with no filesystem.
 */
export const readBuildStamp = (
  resourcesPath: string,
  readFileImpl: (p: string) => string = (p) => readFileSync(p, 'utf8'),
): string | undefined => {
  try {
    const parsed = JSON.parse(readFileImpl(buildStampPath(resourcesPath))) as { build?: unknown } | null
    const build = parsed && typeof parsed.build === 'string' ? parsed.build.trim() : ''
    return build !== '' ? build : undefined
  } catch {
    return undefined
  }
}

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
