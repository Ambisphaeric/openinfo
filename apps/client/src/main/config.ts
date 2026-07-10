import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Client-local shell configuration — resolved from the environment and, for a double-clicked packaged
 * .app, an optional `~/.openinfo/client.json` file — NOT a flag document. Shell behaviours (which engine
 * to talk to, which workspace/surface the HUD shows, where it opens) are how the client paints its own
 * window; they never touch the engine or its store, so a flag document (an engine-side, DB-backed record
 * served over /flags) would be the wrong home. This is the same call the sessions/HUD slices made —
 * flags gate ENGINE processing behaviour; a resource route, a lifecycle record, or a client's own window
 * are none of those. See PHASE2-NOTES.
 *
 * Config STORY (assembled-first-run slice): a `pnpm start` dev run sets env vars easily, but a
 * double-clicked .app inherits none — so a packaged app reads `~/.openinfo/client.json` for its defaults.
 * Precedence is **env > file > built-in defaults**: an explicit env var always wins (so the verifier can
 * still point a packaged app at a remote engine with OPENINFO_ENGINE_URL), the file supplies packaged
 * defaults, and the built-ins (localhost:8787, meeting mode) are the floor. The file is OPTIONAL and
 * best-effort: absent/unreadable/malformed ⇒ ignored, no crash (first run has no file).
 */
export interface ShellConfig {
  /** Base URL of the engine daemon the HUD and tray talk to. */
  engineUrl: string
  /** Workspace the tray's Start Session targets and whose live session the tray reflects. */
  workspace: string
  /** Mode the tray's Start Session runs under (a session requires a modeId — sessions slice). */
  modeId: string
  /** Surface document the HUD window renders. */
  surfaceId: string
  /**
   * Whether the client captures the microphone while a session is live. Client-local, default ON —
   * the session itself is the consent gesture, so a running session captures unless explicitly
   * disabled (OPENINFO_MIC=0/false/off/no, or `"mic": false` in client.json). This is CONFIG, not a
   * flag document, for the same reason every other shell behaviour is (see the header above): it is how
   * the client uses its own hardware, it never touches the engine or its store, and whether captured
   * audio MEANS anything is ALREADY gated engine-side by `distill.transcribe`. See PHASE2-NOTES.
   */
  micEnabled: boolean
  /**
   * Whether the client ALSO captures system audio (the far side of a call — "them") while a session is
   * live, from a BlackHole-like virtual input. Client-local, default ON — but it only ever activates if
   * such a device is actually present (no device ⇒ a silent no-op, mic-only capture), so the default is
   * safe. Same CONFIG-not-flag reasoning as `micEnabled`. Disable with OPENINFO_SYSTEM_AUDIO=0/false/off/no
   * or `"systemAudio": false`.
   */
  systemAudioEnabled: boolean
  /**
   * Whether the client watches the FOREGROUND WINDOW (which app/window/repo is in front) to feed the
   * context-switch detector — a client-local opt-out, default ON. This is the SECOND, client-side gate
   * on focus capture: the FIRST is the engine's `route.detect` flag (context detection is a workspace
   * opt-in; without it the client never polls). Both must be open to poll. It is CONFIG, not a flag, for
   * the same reason micEnabled is — it is how the client reads its own machine (an osascript poll of the
   * frontmost window), it never touches the engine or its store, and whether focus signals MEAN anything
   * is ALREADY gated engine-side by `route.detect`. Disable with OPENINFO_FOCUS=0/false/off/no or
   * `"focus": false` (a privacy kill-switch that stops the polling entirely — not poll-and-drop). See PHASE3-NOTES.
   */
  focusEnabled: boolean
  /**
   * Whether the client captures the SCREEN (periodic still frames of the primary display for OCR/VLM)
   * while a session is live. Client-local — same CONFIG-not-flag reasoning as the toggles above (it is
   * how the client reads its own display; whether frames MEAN anything is gated engine-side by the
   * screen processor's flag). But its DEFAULT is the OPPOSITE of the audio/focus toggles: **default OFF,
   * strictly opt-IN**. The asymmetry is deliberate — screen capture is privacy-heavy (it can see anything
   * on screen, not just a call), it triggers the macOS Screen-Recording TCC prompt, and it is brand-new,
   * so it matches the `capture.camera` posture: nothing is captured unless the user explicitly turns it
   * on. Enable with OPENINFO_SCREEN=1/true/on/yes or `"screen": true`. (The HUD window sets
   * setContentProtection(true) / NSWindowSharingNone, so it excludes ITSELF from these captures.)
   */
  screenEnabled: boolean
  /**
   * How often (ms) to grab a screen still frame while capturing — cadence-based, NOT continuous video.
   * The owner's target cadence for the screenshot stream is the **3–6s band** (issue #4): frequent enough
   * to follow what's on screen, rare enough that each full-display capture + JPEG encode is cheap. Default
   * 5000 (~5s, in band). Only meaningful when `screenEnabled`. Override with OPENINFO_SCREEN_INTERVAL_MS or
   * `"screenIntervalMs"`, but the resolved value is **clamped into [3000, 6000]** so no configuration can
   * spin capture too hot (a sub-second flood of full-display JPEG encodes) or so slow the stream is
   * effectively dead: an out-of-band value snaps to the nearest bound, and a non-positive/garbage value
   * falls back to the default. See SCREEN_INTERVAL_MIN_MS / SCREEN_INTERVAL_MAX_MS and resolveScreenIntervalMs.
   */
  screenIntervalMs: number
  /**
   * Audio capture segment length in ms — how often the hidden renderer stops-and-restarts its
   * MediaRecorder to cut one complete, independently-decodable webm file (capture-renderer.ts explains
   * why segmenting is stop/restart, never `timeslice`). This is the DOMINANT capture latency: a spoken
   * word waits up to one segment before its audio even leaves the client, so the default is **1000 (~1s)**
   * — small enough for a real-time surface, large enough to amortize the per-request + stop/restart
   * overhead (the engine merges chunks into larger windows downstream). Client-local CONFIG, not a flag
   * document, for the same reason every other capture behaviour is (it is how the client drives its own
   * recorder; it never touches the engine or its store). The resolved value is sent to the renderer with
   * each `capture:start` and is the chunk's `durationMs`. Override with OPENINFO_SEGMENT_MS or
   * `"segmentMs"`; a non-positive/garbage value falls back to the default. See PHASE4-NOTES (#57).
   */
  segmentMs: number
  /**
   * Debug: draw visible outlines around the HUD window's bounds and its painted panel. The HUD window
   * is frameless and TRANSPARENT — when nothing paints (engine unreachable, empty layout) there is
   * nothing to see, which reads as "the HUD disappeared". Opt-IN (default OFF — it is debug chrome):
   * OPENINFO_HUD_OUTLINE=1/true/on/yes or `"hudOutline": true`. CONFIG, not a flag document, like every
   * other shell-window behaviour (this is how the client paints its own window; it must work precisely
   * when the engine — where flag documents live — is unreachable).
   */
  hudOutline: boolean
}

/**
 * The optional `~/.openinfo/client.json` shape — every field optional (a partial override of the
 * built-in defaults, itself overridable by env). Unknown keys are ignored; wrong-typed values are
 * dropped (treated as absent) so a hand-edited file can never crash the shell — see parseClientConfigFile.
 */
export interface ClientConfigFile {
  engineUrl?: string
  workspace?: string
  modeId?: string
  surfaceId?: string
  mic?: boolean
  systemAudio?: boolean
  focus?: boolean
  screen?: boolean
  screenIntervalMs?: number
  segmentMs?: number
  hudOutline?: boolean
}

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  workspace: 'default',
  modeId: 'mode-meeting',
  surfaceId: 'surf-openinfo-hud',
  screenIntervalMs: 5000,
  segmentMs: 1000,
} as const

/**
 * The senses-on defaults — which capture senses are ENABLED out of the box (issue #4). This is the single
 * source of truth for "which senses are on" so the story is first-class and pinned by a test, not scattered
 * across the resolver helpers. It governs what captures ONCE A SESSION IS LIVE — nothing captures before the
 * tray's Start Session (the session itself is the consent gesture; see capture-consent.ts and applyCaptureLifecycle).
 * - mic / systemAudio / focus default **ON** — and each is safe on: system-audio is a silent no-op without a
 *   BlackHole-class loopback device, and focus is a no-op unless the engine's route.detect flag is also on.
 * - screen defaults **OFF** — strictly opt-in. The asymmetry is deliberate: screen capture is privacy-heavy
 *   (it can see anything on screen), triggers the macOS Screen-Recording TCC prompt, and matches the
 *   `capture.camera` posture — nothing is captured unless the user explicitly turns it on. See screenEnabled.
 */
export const SENSE_DEFAULTS = {
  mic: true,
  systemAudio: true,
  focus: true,
  screen: false,
} as const

/**
 * The screen-capture cadence band (ms), issue #4 — the owner's stated target for the screenshot stream is
 * 3–6s, so a resolved `screenIntervalMs` is clamped into [MIN, MAX]. The FLOOR stops a bad value spinning
 * capture too hot (a sub-second flood of full-display JPEG encodes); the CEILING stops a value so large the
 * stream is effectively dead while the sense still reads as "on". DEFAULTS.screenIntervalMs (5000) sits in band.
 */
export const SCREEN_INTERVAL_MIN_MS = 3000
export const SCREEN_INTERVAL_MAX_MS = 6000

/** OPENINFO_MIC / OPENINFO_SYSTEM_AUDIO / OPENINFO_FOCUS are opt-OUT: only an explicit falsy token disables. */
const isFalsyToken = (raw: string): boolean => ['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase())

/** OPENINFO_SCREEN is opt-IN (privacy-heavy, default OFF): only an explicit truthy token enables. */
const isTruthyToken = (raw: string): boolean => ['1', 'true', 'on', 'yes'].includes(raw.trim().toLowerCase())

/**
 * Resolve an opt-OUT (default-ON) boolean across the three sources: an explicit env token wins (only a
 * falsy one disables), else the file value if present, else the passed default (the senses-on default —
 * ON — from SENSE_DEFAULTS). This is how env keeps beating client.json for the capture toggles, mirroring
 * the string/url precedence.
 */
const resolveEnabled = (envRaw: string | undefined, fileVal: boolean | undefined, def: boolean): boolean => {
  if (envRaw !== undefined) return !isFalsyToken(envRaw)
  if (fileVal !== undefined) return fileVal
  return def
}

/**
 * The opt-IN mirror of resolveEnabled: an explicit env token wins (only a truthy one enables), else the
 * file value if present, else the passed default (OFF for screen — SENSE_DEFAULTS.screen — and for the
 * hudOutline debug chrome). Same env > file > default precedence — just flipped so nothing turns on unless
 * explicitly asked. See screenEnabled.
 */
const resolveOptIn = (envRaw: string | undefined, fileVal: boolean | undefined, def: boolean): boolean => {
  if (envRaw !== undefined) return isTruthyToken(envRaw)
  if (fileVal !== undefined) return fileVal
  return def
}

/** Resolve a positive-integer ms interval: env token (if a valid positive number) > file value > default. */
const resolveIntervalMs = (envRaw: string | undefined, fileVal: number | undefined, def: number): number => {
  const fromEnv = envRaw !== undefined ? Number(envRaw) : undefined
  if (fromEnv !== undefined && Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv
  if (fileVal !== undefined && Number.isFinite(fileVal) && fileVal > 0) return fileVal
  return def
}

/**
 * Resolve the screen-capture cadence (issue #4): the same env > file > default precedence as
 * resolveIntervalMs, but the chosen value is rounded to a whole ms and **clamped into the target band
 * [SCREEN_INTERVAL_MIN_MS, SCREEN_INTERVAL_MAX_MS]** — an out-of-band value snaps to the nearest bound so
 * no configuration can spin capture too hot or so slow the stream is dead, and a non-positive/garbage value
 * falls back to the default (itself in band). Separate from resolveIntervalMs because segmentMs is a
 * different cadence with its own, un-clamped band (its default is 1000 and larger values are legitimate).
 */
const resolveScreenIntervalMs = (envRaw: string | undefined, fileVal: number | undefined, def: number): number => {
  const chosen = resolveIntervalMs(envRaw, fileVal, def)
  return Math.min(Math.max(Math.round(chosen), SCREEN_INTERVAL_MIN_MS), SCREEN_INTERVAL_MAX_MS)
}

/** Trim a trailing slash so `${engineUrl}${path}` never doubles up. */
const normalizeUrl = (url: string): string => url.replace(/\/+$/, '')

const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const asBool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)
const asNumber = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/**
 * Validate a parsed JSON blob into a ClientConfigFile — pure, so the packaged-app config story is
 * asserted headless. Non-objects yield undefined; wrong-typed fields are dropped (treated as absent), so
 * a hand-edited file with a stray value degrades to its valid subset rather than crashing the shell.
 */
export const parseClientConfigFile = (raw: unknown): ClientConfigFile | undefined => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const out: ClientConfigFile = {}
  const engineUrl = asString(r['engineUrl'])
  if (engineUrl !== undefined) out.engineUrl = engineUrl
  const workspace = asString(r['workspace'])
  if (workspace !== undefined) out.workspace = workspace
  const modeId = asString(r['modeId'])
  if (modeId !== undefined) out.modeId = modeId
  const surfaceId = asString(r['surfaceId'])
  if (surfaceId !== undefined) out.surfaceId = surfaceId
  const mic = asBool(r['mic'])
  if (mic !== undefined) out.mic = mic
  const systemAudio = asBool(r['systemAudio'])
  if (systemAudio !== undefined) out.systemAudio = systemAudio
  const focus = asBool(r['focus'])
  if (focus !== undefined) out.focus = focus
  const screen = asBool(r['screen'])
  if (screen !== undefined) out.screen = screen
  const screenIntervalMs = asNumber(r['screenIntervalMs'])
  if (screenIntervalMs !== undefined) out.screenIntervalMs = screenIntervalMs
  const segmentMs = asNumber(r['segmentMs'])
  if (segmentMs !== undefined) out.segmentMs = segmentMs
  const hudOutline = asBool(r['hudOutline'])
  if (hudOutline !== undefined) out.hudOutline = hudOutline
  return out
}

/** The packaged-app config file path — `~/.openinfo/client.json` (beside the engine's `~/.openinfo/data`). */
export const clientConfigPath = (home: string = os.homedir()): string => path.join(home, '.openinfo', 'client.json')

/**
 * Read `~/.openinfo/client.json` if present. Best-effort: absent/unreadable/malformed ⇒ undefined (the
 * shell then resolves from env + defaults). The thin IO edge; the merge + validation stay pure above so
 * they round-trip in a headless test against a temp file.
 */
export const loadClientConfigFile = (filePath: string = clientConfigPath()): ClientConfigFile | undefined => {
  try {
    return parseClientConfigFile(JSON.parse(readFileSync(filePath, 'utf8')))
  } catch {
    return undefined // no file (first run / dev), or an unreadable/malformed one — resolve from env + defaults
  }
}

/**
 * Resolve the shell config from an env map (defaulting to `process.env`) and an optional file override.
 * Precedence is **env > file > defaults** per field:
 * - engineUrl: `OPENINFO_ENGINE_URL` wins; else `OPENINFO_ENGINE_HOST`/`OPENINFO_PORT` compose one (if
 *   either is set); else the file's `engineUrl`; else `http://127.0.0.1:8787`.
 * - workspace/modeId/surfaceId: the env var, else the file value, else the default.
 * - the audio/focus toggles: an explicit env token (opt-out), else the file boolean, else the senses-on
 *   default (ON — SENSE_DEFAULTS).
 * - screen: an explicit env token (opt-IN), else the file boolean, else OFF (SENSE_DEFAULTS.screen);
 *   screenIntervalMs: env/file/5000, then clamped into the 3–6s band (issue #4 — see resolveScreenIntervalMs).
 * - segmentMs: a valid positive env number, else the file value, else 1000 (~1s) — the capture cadence (#57).
 */
export const resolveShellConfig = (
  env: Record<string, string | undefined> = process.env,
  file?: ClientConfigFile,
): ShellConfig => {
  const explicitEnvUrl = env['OPENINFO_ENGINE_URL']
  const envHost = env['OPENINFO_ENGINE_HOST']
  const envPort = env['OPENINFO_PORT']
  let engineUrl: string
  if (explicitEnvUrl !== undefined) engineUrl = explicitEnvUrl
  else if (envHost !== undefined || envPort !== undefined)
    engineUrl = `http://${envHost ?? DEFAULTS.host}:${Number(envPort ?? DEFAULTS.port)}`
  else if (file?.engineUrl !== undefined) engineUrl = file.engineUrl
  else engineUrl = `http://${DEFAULTS.host}:${DEFAULTS.port}`
  return {
    engineUrl: normalizeUrl(engineUrl),
    workspace: env['OPENINFO_WORKSPACE'] ?? file?.workspace ?? DEFAULTS.workspace,
    modeId: env['OPENINFO_MODE'] ?? file?.modeId ?? DEFAULTS.modeId,
    surfaceId: env['OPENINFO_SURFACE'] ?? file?.surfaceId ?? DEFAULTS.surfaceId,
    micEnabled: resolveEnabled(env['OPENINFO_MIC'], file?.mic, SENSE_DEFAULTS.mic),
    systemAudioEnabled: resolveEnabled(env['OPENINFO_SYSTEM_AUDIO'], file?.systemAudio, SENSE_DEFAULTS.systemAudio),
    focusEnabled: resolveEnabled(env['OPENINFO_FOCUS'], file?.focus, SENSE_DEFAULTS.focus),
    screenEnabled: resolveOptIn(env['OPENINFO_SCREEN'], file?.screen, SENSE_DEFAULTS.screen),
    screenIntervalMs: resolveScreenIntervalMs(env['OPENINFO_SCREEN_INTERVAL_MS'], file?.screenIntervalMs, DEFAULTS.screenIntervalMs),
    segmentMs: resolveIntervalMs(env['OPENINFO_SEGMENT_MS'], file?.segmentMs, DEFAULTS.segmentMs),
    hudOutline: resolveOptIn(env['OPENINFO_HUD_OUTLINE'], file?.hudOutline, false),
  }
}
