/**
 * Client-local shell configuration — resolved from the environment, NOT a flag document. Shell
 * behaviours (which engine to talk to, which workspace/surface the HUD shows, where it opens) are
 * how the client paints its own window; they never touch the engine or its store, so a flag
 * document (an engine-side, DB-backed record served over /flags) would be the wrong home. This is
 * the same call the sessions/HUD slices made — flags gate ENGINE processing behaviour; a resource
 * route, a lifecycle record, or (here) a client's own window are none of those. See PHASE2-NOTES.
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
   * disabled (OPENINFO_MIC=0/false/off/no). This is CONFIG, not a flag document, for the same reason
   * every other shell behaviour is (see the header above): it is how the client uses its own
   * hardware, it never touches the engine or its store, and whether captured audio MEANS anything is
   * ALREADY gated engine-side by `distill.transcribe` — a client `capture.mic` flag would gate
   * nothing the engine can see. See PHASE2-NOTES (config-not-flags line).
   */
  micEnabled: boolean
  /**
   * Whether the client ALSO captures system audio (the far side of a call — "them") while a session is
   * live, from a BlackHole-like virtual input. Client-local, default ON — but it only ever activates if
   * such a device is actually present (no device ⇒ a silent no-op, mic-only capture), so the default is
   * safe. Same CONFIG-not-flag reasoning as `micEnabled`. Disable with OPENINFO_SYSTEM_AUDIO=0/false/off/no.
   */
  systemAudioEnabled: boolean
}

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  workspace: 'default',
  modeId: 'mode-meeting',
  surfaceId: 'surf-openinfo-hud',
} as const

/** OPENINFO_MIC / OPENINFO_SYSTEM_AUDIO are opt-OUT: unset ⇒ on; only an explicit falsy token disables. */
const isEnabled = (raw: string | undefined): boolean =>
  raw === undefined || !['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase())

/** Trim a trailing slash so `${engineUrl}${path}` never doubles up. */
const normalizeUrl = (url: string): string => url.replace(/\/+$/, '')

/**
 * Resolve the shell config from an env map (defaulting to `process.env`). `OPENINFO_ENGINE_URL`
 * wins; otherwise a URL is built from `OPENINFO_ENGINE_HOST`/`OPENINFO_PORT` with localhost:8787
 * defaults — the same port the engine listens on (`OPENINFO_PORT`, engine/main.ts).
 */
export const resolveShellConfig = (env: Record<string, string | undefined> = process.env): ShellConfig => {
  const explicit = env['OPENINFO_ENGINE_URL']
  const host = env['OPENINFO_ENGINE_HOST'] ?? DEFAULTS.host
  const port = Number(env['OPENINFO_PORT'] ?? DEFAULTS.port)
  const engineUrl = normalizeUrl(explicit ?? `http://${host}:${port}`)
  return {
    engineUrl,
    workspace: env['OPENINFO_WORKSPACE'] ?? DEFAULTS.workspace,
    modeId: env['OPENINFO_MODE'] ?? DEFAULTS.modeId,
    surfaceId: env['OPENINFO_SURFACE'] ?? DEFAULTS.surfaceId,
    micEnabled: isEnabled(env['OPENINFO_MIC']),
    systemAudioEnabled: isEnabled(env['OPENINFO_SYSTEM_AUDIO']),
  }
}
