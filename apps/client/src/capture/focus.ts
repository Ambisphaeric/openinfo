import type { CaptureChunk, FocusSignal } from '@openinfo/contracts'

/**
 * Focus capture — the pure assembly + heuristics, so the title→repoPath parser, the secret-redaction
 * pass, the dedupe key, and the CaptureChunk shaping are all asserted headless (no electron, no
 * osascript, no display). The shell (shell.ts) owns the ONE electron edge — reading the frontmost app +
 * window title off the OS (an osascript / System Events poll) — and hands each raw sample here; the
 * FocusPoller (focus-poller.ts) drives the cadence/dedupe/gating around it.
 *
 * A focus signal is machine-global foreground CONTEXT (which app/window/repo is in front), NOT speech.
 * It rides the ordinary capture seam: `source: 'focus'`, `encoding: 'utf8'`, `contentType:
 * 'application/json'`, `data` = JSON.stringify(FocusSignal) — so the client, spool, and engine drain
 * need no new transport (the detector agent decodes it and EXCLUDES it from transcripts/moments/
 * entities: it is evidence for *where* a session belongs, never content *in* one). See PHASE3-NOTES.
 *
 * PRIVACY: window titles are sensitive (they leak file names, URLs, message subjects). Two guards live
 * around this module — the engine's `route.detect` flag AND a client-local opt-out gate whether we poll
 * at ALL (focus-poller.ts), and `redactTitle` below scrubs obvious secrets from any title we do emit.
 */

/**
 * The raw frontmost-window reading the OS reader returns — app name always, window title when the OS
 * (and TCC) let us see it. `undefined` from the reader (denied/failed) is handled by the poller (it
 * keeps its last state and emits nothing) — this shape is only the SUCCESS case.
 */
export interface FrontmostWindow {
  /** Foreground application name, e.g. "Code", "Slack", "zoom.us" — never empty on a real read. */
  app: string
  /** The active window's title, when the OS exposes it (may be absent even when the app name is not). */
  windowTitle?: string
}

/** How often the poller samples the frontmost window. Constant, modest — context, not keystrokes. */
export const FOCUS_POLL_INTERVAL_MS = 3000

/**
 * Emission rate cap. Even when the frontmost window keeps *changing* (a title that ticks a progress
 * counter, a rapid alt-tab flurry), we emit at most one focus chunk per this window — a belt-and-braces
 * throttle on top of the fixed-cadence poll + on-change dedupe. A change suppressed by the throttle is
 * NOT recorded as "last seen", so it is re-evaluated (and emitted) on the next eligible tick.
 */
export const FOCUS_MIN_EMIT_INTERVAL_MS = 1000

/**
 * The sessionId every focus chunk carries. Focus signals flow OUTSIDE sessions BY DESIGN — they are
 * what STARTS sessions, so there is usually no live session when one fires. The CaptureChunk contract
 * still requires a non-empty `sessionId` (Id = minLength 1), and the engine's `/capture` route
 * validates the shape but does NOT verify the session exists, so a stable sentinel satisfies the seam
 * honestly: the detector routes focus by `source`, never by this id. (Same call sim.ts made — supply a
 * value the route accepts rather than reworking the seam.)
 */
export const FOCUS_SESSION_SENTINEL = 'focus-context'

/**
 * Ordered repo-path extraction rules, best-known dev apps first — the title→repoPath heuristic. v0
 * derives the repo identifier from the window TITLE of a known editor/terminal; we NEVER shell out to
 * inspect other processes' cwd (that would need far more privilege and is a native-reader concern
 * later). An in-code ordered constant, not a seeded document, for the same reason device-match.ts's
 * pattern list is: a tiny, client-local, single-purpose heuristic that never crosses the seam.
 *
 * HONESTY / WART: a title only exposes what the app chose to put there. Editors (VS Code/Cursor) show
 * the workspace ROOT NAME (e.g. "openinfo"), not an absolute path; path-showing terminals expose a real
 * path. So v0 `repoPath` is a best-effort IDENTIFIER — often a bare project name, sometimes a real path
 * — good enough for the detector to match a session to a repo. The true absolute git root awaits a
 * native reader / a `git -C` resolution (a later slice). Rules return undefined rather than guess wildly.
 */
export interface RepoRule {
  /** lowercased app-name substrings this rule applies to (matched against FocusSignal.app). */
  apps: readonly string[]
  /** extract a repo identifier from the window title, or undefined when the title doesn't yield one. */
  extract: (windowTitle: string) => string | undefined
}

/** The em-dash VS Code / Cursor / Terminal.app use as their title separator (U+2014). */
const EM_DASH = '—'

/** A "~/x/y" or "/x/y" path token — what path-showing shells put in their title. */
const PATH_TOKEN = /(~?(?:\/[\w.@%+-]+)+\/?)/

/** Strip a trailing " — Visual Studio Code" / " — Cursor" app-name suffix some title templates add. */
const stripEditorSuffix = (title: string): string =>
  title.replace(new RegExp(`\\s*[${EM_DASH}-]\\s*(Visual Studio Code|Cursor)\\s*$`, 'i'), '').trim()

export const REPO_RULES: readonly RepoRule[] = [
  {
    // VS Code / Cursor default title template: "<activeEditorShort> — <rootName>" (em-dash separated).
    // The LAST segment after stripping any app-name suffix is the workspace root name.
    apps: ['visual studio code', 'code', 'code - insiders', 'cursor', 'vscodium'],
    extract: (title) => {
      const parts = stripEditorSuffix(title)
        .split(EM_DASH)
        .map((p) => p.trim())
        .filter(Boolean)
      // Need at least "<file> — <root>": a lone segment can't be told apart from a bare file name.
      return parts.length >= 2 ? parts[parts.length - 1] : undefined
    },
  },
  {
    // Terminal.app / iTerm2: prefer a real path token (iTerm often shows "~/openinfo/apps/client");
    // else Terminal.app's leading "<cwd-basename> — <proc> — <size>" gives the basename as a fallback.
    apps: ['terminal', 'iterm', 'iterm2', 'alacritty', 'wezterm', 'kitty', 'ghostty'],
    extract: (title) => {
      const path = title.match(PATH_TOKEN)?.[1]
      if (path) return path
      const first = title.split(new RegExp(`\\s*${EM_DASH}\\s*`))[0]?.trim()
      return first && !first.includes(' ') ? first : undefined
    },
  },
]

/**
 * Derive a repo identifier from a known dev app's window title, or undefined. App match is
 * case-insensitive substring (so "Code" matches "code", "iTerm2" matches "iterm"). First matching rule
 * that yields a value wins (ordered by preference); a non-dev app (Slack, a browser) yields nothing.
 */
export const parseRepoPath = (app: string, windowTitle: string | undefined): string | undefined => {
  if (!windowTitle) return undefined
  const appLower = app.toLowerCase()
  for (const rule of REPO_RULES) {
    if (!rule.apps.some((a) => appLower.includes(a))) continue
    const hit = rule.extract(windowTitle)
    if (hit) return hit
  }
  return undefined
}

/**
 * Conservative secret-redaction patterns for window titles — a BEST-EFFORT v0 constant (warts stated).
 * It scrubs the shapes that most obviously leak credentials: provider token prefixes, bearer tokens,
 * emails, secret-ish key=value pairs, and long hex/hash runs. It is NOT a guarantee — a novel token
 * format sails through, and it can over-redact (an email in a legitimate title becomes "[redacted]").
 * We err toward redaction: a title is low-value context, so losing a token-shaped word to caution is
 * cheap. The real fix (never capturing sensitive titles) is per-app allow/deny lists, a later slice.
 */
export const REDACTION_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9]{16,}\b/g, // openai / stripe-style secret keys
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, // github personal / oauth / server / refresh tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // slack tokens
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, // aws access key id
  /\bBearer\s+[A-Za-z0-9\-._~+/]{8,}=*/gi, // bearer tokens
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, // emails
  /\b(?:password|passwd|pwd|secret|token|api[-_]?key|apikey|access[-_]?key)\s*[=:]\s*\S+/gi, // key=value
  /\b[A-Fa-f0-9]{32,}\b/g, // long hex runs (hashes / hex-encoded keys)
]

/** The redaction placeholder — kept short so a scrubbed title still reads as a title. */
export const REDACTED = '[redacted]'

/** Scrub obvious secrets from a window title (best-effort — see REDACTION_PATTERNS). */
export const redactTitle = (title: string): string =>
  REDACTION_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, REDACTED), title)

/**
 * Build the FocusSignal from a raw frontmost-window reading: the app name rides through; the title is
 * redacted (never emitted raw); repoPath is derived from the title for known dev apps. Optional fields
 * are OMITTED (not set to undefined) so the payload validates under FocusSignal's additionalProperties:
 * false and stays minimal. A whitespace-only title after redaction is dropped.
 */
export const buildFocusSignal = (raw: FrontmostWindow): FocusSignal => {
  const signal: FocusSignal = { app: raw.app }
  if (raw.windowTitle) {
    const redacted = redactTitle(raw.windowTitle).trim()
    if (redacted) signal.windowTitle = redacted
    const repoPath = parseRepoPath(raw.app, raw.windowTitle)
    if (repoPath) signal.repoPath = repoPath
  }
  return signal
}

/**
 * The dedupe key: two consecutive samples with the same app + title + repoPath are the SAME context, so
 * the poller emits nothing between them (emit-only-on-change). Built off the redacted signal so a change
 * that only differs in a redacted-away secret does not spuriously re-emit.
 */
export const focusSignalKey = (signal: FocusSignal): string =>
  `${signal.app} ${signal.windowTitle ?? ''} ${signal.repoPath ?? ''}`

/** The ids a focus chunk is stamped with — a per-process run id keeps chunk ids collision-free across runs. */
export interface FocusEmitContext {
  workspaceId: string
  /** Stable for one client run (folded into the chunk id so two runs never collide at the same sequence). */
  runId: string
}

const pad = (value: number): string => String(value).padStart(6, '0')

/**
 * Wrap a FocusSignal as an ordinary CaptureChunk per the seam: `source: 'focus'`, `encoding: 'utf8'`,
 * `contentType: 'application/json'`, `data` = JSON.stringify(signal). The sessionId is the sentinel
 * (focus flows outside sessions); the id folds the run id + a monotonic sequence so it is stable and
 * collision-free without a session to key off.
 */
export const focusChunk = (
  signal: FocusSignal,
  ctx: FocusEmitContext,
  sequence: number,
  capturedAt: string,
): CaptureChunk => ({
  id: `focus-${ctx.runId}-${pad(sequence)}`,
  sessionId: FOCUS_SESSION_SENTINEL,
  workspaceId: ctx.workspaceId,
  source: 'focus',
  sequence,
  capturedAt,
  contentType: 'application/json',
  encoding: 'utf8',
  data: JSON.stringify(signal),
})
