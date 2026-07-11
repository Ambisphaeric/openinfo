/**
 * ECHO-DEDUPE (sys-audio arc, follow-up to #142). Mic and system-audio are separate capture streams by
 * design; with the CoreAudio tap a speakers-on call produces the SAME words on BOTH: the tap carries the
 * clean far-side signal while the physical mic picks up speaker bleed — so the live transcript shows
 * near-duplicate lines, the mic copy garbled and mislabeled `mic · me`. This module is the deterministic
 * engine-side fix: buffer recent SYSTEM-stream fragments per session, and let the wiring drop a MIC
 * fragment whose text near-duplicates a buffered system fragment captured within the match window.
 *
 * Pure of engine internals (no bus/store/fabric imports) so it stays trivially unit-testable. Stateful
 * only in the rolling buffer + per-session suppression counters. The wiring (api/http.ts runTranscribe)
 * feeds system fragments and checks mic fragments over freshly-transcribed text, BEFORE persistence
 * (text queue) and publication (transcript.updated).
 *
 * Match rule: token-set (Jaccard) similarity >= ECHO_DEDUPE_SIMILARITY against some system fragment
 * whose capturedAt is within +/-ECHO_DEDUPE_WINDOW_MS — or full mic-side containment (every mic token
 * present in the system fragment) for the short-fragment case where chunk boundaries differ and Jaccard
 * under-scores. Containment is deliberately DIRECTIONAL (mic within system only): a mic window holding
 * the user's own words PLUS a short bled system phrase must never be dropped. Guard: mic fragments with
 * fewer than ECHO_DEDUPE_MIN_MIC_TOKENS unique tokens are NEVER dropped (protect "yeah", "okay" — real
 * backchannel speech that coincides with far-side words by nature, not by bleed).
 */

/** A transcribed fragment as the wiring sees it: session-scoped text with its capture timestamp (ISO). */
export interface EchoFragment {
  sessionId: string
  text: string
  capturedAt: string
}

/** How long a system fragment stays matchable, ms — the rolling buffer horizon (pruned on insert). */
export const ECHO_DEDUPE_BUFFER_MS = 30_000
/** Max |capturedAt(mic) - capturedAt(system)| for a pair to be compared, ms. Bleed is near-simultaneous. */
export const ECHO_DEDUPE_WINDOW_MS = 2_000
/** Token-set Jaccard similarity at/above which a windowed pair is an echo. */
export const ECHO_DEDUPE_SIMILARITY = 0.8
/** Mic fragments with fewer unique tokens than this are never dropped (backchannel guard). */
export const ECHO_DEDUPE_MIN_MIC_TOKENS = 3
/** Kill-switch env var: set to '0' to disable the dedupe. Default ON — harmless with no system stream. */
export const ECHO_DEDUPE_ENV = 'OPENINFO_ECHO_DEDUPE'

/** Resolved once at wiring time, like the other engine env knobs. Anything but the literal '0' is ON. */
export const echoDedupeEnabled = (env: Record<string, string | undefined>): boolean => env[ECHO_DEDUPE_ENV] !== '0'

/** Lowercase, strip punctuation (any non letter/digit run becomes a space), collapse whitespace. */
export const normalizeEchoText = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const tokenSet = (text: string): Set<string> => {
  const norm = normalizeEchoText(text)
  return new Set(norm.length === 0 ? [] : norm.split(' '))
}

/** Jaccard >= threshold, or every mic token present in the system set (directional containment). */
const isNearDuplicate = (mic: ReadonlySet<string>, system: ReadonlySet<string>): boolean => {
  let intersection = 0
  for (const token of mic) if (system.has(token)) intersection += 1
  if (intersection === mic.size) return true
  const union = mic.size + system.size - intersection
  return union > 0 && intersection / union >= ECHO_DEDUPE_SIMILARITY
}

interface BufferedFragment {
  tokens: Set<string>
  capturedAt: number
}

/**
 * Per-session rolling buffer of recent system-stream fragments + the echo check the wiring runs on mic
 * fragments. Forward-only by construction: a mic fragment is compared against system fragments ALREADY
 * observed — the single-flight drain means a mic fragment transcribed in an earlier drain than its
 * system twin never matches (accepted v1 asymmetry; the wiring narrows it within a drain by observing
 * all of a drain's system fragments before checking any of its mic fragments).
 */
export class EchoDedupe {
  private readonly buffers = new Map<string, BufferedFragment[]>()
  private readonly suppressed = new Map<string, number>()

  /** Feed a freshly-transcribed system-audio fragment. Prunes the horizon (all sessions) on insert. */
  observeSystem(fragment: EchoFragment): void {
    const capturedAt = Date.parse(fragment.capturedAt)
    if (!Number.isFinite(capturedAt)) return
    const tokens = tokenSet(fragment.text)
    if (tokens.size === 0) return
    const kept = (this.buffers.get(fragment.sessionId) ?? []).filter((b) => capturedAt - b.capturedAt <= ECHO_DEDUPE_BUFFER_MS)
    kept.push({ tokens, capturedAt })
    this.buffers.set(fragment.sessionId, kept)
    // Bound memory across sessions too: drop buffers whose every fragment has aged out of the horizon
    // (ended sessions would otherwise pin their last 30s of system text forever).
    for (const [sessionId, buffer] of this.buffers) {
      if (!buffer.some((b) => capturedAt - b.capturedAt <= ECHO_DEDUPE_BUFFER_MS)) this.buffers.delete(sessionId)
    }
  }

  /**
   * True when this mic fragment near-duplicates a buffered system fragment of the same session within
   * the match window — i.e. it is speaker bleed and the wiring should drop it. Every true return counts
   * one suppression for the session (the wiring always drops on true), readable via suppressedCount.
   */
  isEcho(fragment: EchoFragment): boolean {
    const buffer = this.buffers.get(fragment.sessionId)
    if (buffer === undefined || buffer.length === 0) return false
    const capturedAt = Date.parse(fragment.capturedAt)
    if (!Number.isFinite(capturedAt)) return false
    const mic = tokenSet(fragment.text)
    if (mic.size < ECHO_DEDUPE_MIN_MIC_TOKENS) return false
    for (const candidate of buffer) {
      if (Math.abs(capturedAt - candidate.capturedAt) > ECHO_DEDUPE_WINDOW_MS) continue
      if (isNearDuplicate(mic, candidate.tokens)) {
        this.suppressed.set(fragment.sessionId, (this.suppressed.get(fragment.sessionId) ?? 0) + 1)
        return true
      }
    }
    return false
  }

  /** Running echoSuppressed count for a session (0 when none). A later slice surfaces this in Diagnostics. */
  suppressedCount(sessionId: string): number {
    return this.suppressed.get(sessionId) ?? 0
  }
}
