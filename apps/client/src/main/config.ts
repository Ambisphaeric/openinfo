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
}

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  workspace: 'default',
  modeId: 'mode-meeting',
  surfaceId: 'surf-openinfo-hud',
} as const

/** OPENINFO_MIC / OPENINFO_SYSTEM_AUDIO / OPENINFO_FOCUS are opt-OUT: only an explicit falsy token disables. */
const isFalsyToken = (raw: string): boolean => ['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase())

/**
 * Resolve a default-ON boolean across the three sources: an explicit env token wins (opt-out), else the
 * file value if present, else the built-in default (ON). This is how env keeps beating client.json for
 * the capture toggles, mirroring the string/url precedence.
 */
const resolveEnabled = (envRaw: string | undefined, fileVal: boolean | undefined): boolean => {
  if (envRaw !== undefined) return !isFalsyToken(envRaw)
  if (fileVal !== undefined) return fileVal
  return true
}

/** Trim a trailing slash so `${engineUrl}${path}` never doubles up. */
const normalizeUrl = (url: string): string => url.replace(/\/+$/, '')

const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const asBool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)

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
 * - the capture toggles: an explicit env token (opt-out), else the file boolean, else ON.
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
    micEnabled: resolveEnabled(env['OPENINFO_MIC'], file?.mic),
    systemAudioEnabled: resolveEnabled(env['OPENINFO_SYSTEM_AUDIO'], file?.systemAudio),
    focusEnabled: resolveEnabled(env['OPENINFO_FOCUS'], file?.focus),
  }
}
