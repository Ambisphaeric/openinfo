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
 * Match rule — TWO tiers, both directional and time-gated:
 *   CONFIDENT tier (within +/-ECHO_DEDUPE_WINDOW_MS): token-set (Jaccard) similarity >= ECHO_DEDUPE_SIMILARITY,
 *   or full mic-side containment (every mic token present in the system fragment) for the short-fragment
 *   case where chunk boundaries differ and Jaccard under-scores.
 *   GARBLE tier (within the TIGHTER +/-ECHO_DEDUPE_TIGHT_WINDOW_MS, follow-up to #151): a LOWER, directional
 *   mic-coverage bar (fraction of mic tokens present in the system fragment >= ECHO_DEDUPE_TIGHT_COVERAGE) for
 *   mic fragments of at least ECHO_DEDUPE_TIGHT_MIN_MIC_TOKENS unique tokens. This is the loud-bleed miss:
 *   at high volume the mic pickup of the speaker transcribes IMPERFECTLY (substituted/split/dropped words),
 *   so the twin's Jaccard drops below 0.8 — but the bleed is essentially SIMULTANEOUS with the playback, far
 *   tighter than the 2s confident window, and most of the (short) mic fragment still echoes the far side.
 *   Relaxing the OVERLAP only inside a much TIGHTER TIME window keeps genuine dialogue safe: two people do
 *   not utter half-the-same content words within ~750ms of each other by coincidence — that near-simultaneity
 *   is the bleed signature, not conversation.
 * Both tiers are deliberately DIRECTIONAL (mic within system only): a mic window holding the user's own words
 * PLUS a short bled system phrase must never be dropped (full containment is coverage 1.0; the garble tier
 * relaxes that ceiling, never the direction). Guard: mic fragments with fewer than ECHO_DEDUPE_MIN_MIC_TOKENS
 * unique tokens are NEVER dropped (protect "yeah", "okay" — real backchannel that coincides with far-side
 * words by nature, not by bleed); the garble tier holds an even higher token floor so a short coincidental
 * half-overlap can never trip the relaxed bar. Eating genuine mic speech is worse than leaving a phantom
 * row, so the false-positive floor — not the catch rate — sets these knobs (tuned against echo-bleed-fixtures.ts).
 */

/** A transcribed fragment as the wiring sees it: session-scoped text with its capture timestamp (ISO). */
export interface EchoFragment {
  sessionId: string
  text: string
  capturedAt: string
}

/** How long a system fragment stays matchable, ms — the rolling buffer horizon (pruned on insert). */
export const ECHO_DEDUPE_BUFFER_MS = 30_000
/** Max |capturedAt(mic) - capturedAt(system)| for the CONFIDENT tier, ms. Bleed is near-simultaneous. */
export const ECHO_DEDUPE_WINDOW_MS = 2_000
/** Token-set Jaccard similarity at/above which a confident-tier windowed pair is an echo. */
export const ECHO_DEDUPE_SIMILARITY = 0.8
/** Mic fragments with fewer unique tokens than this are never dropped (backchannel guard). */
export const ECHO_DEDUPE_MIN_MIC_TOKENS = 3

/**
 * GARBLE tier (follow-up to #151). Tight, near-simultaneous window, ms: loud speaker bleed transcribes
 * imperfectly so the twin's overlap falls below the confident 0.8 bar, but the mic hears the speaker within
 * a fraction of a second of playback — far tighter than the 2s confident window. Outside this window the
 * overlap bar is NEVER relaxed (topical dialogue that shares words with the far side is seconds apart).
 */
export const ECHO_DEDUPE_TIGHT_WINDOW_MS = 750
/**
 * GARBLE tier directional bar: the fraction of the MIC fragment's tokens that must also appear in the
 * system fragment. Full containment is coverage 1.0; this relaxes the ceiling to catch the garbled minority
 * of tokens, while staying DIRECTIONAL (mic⊆system), so a long mic utterance merely CONTAINING a short bled
 * phrase stays far below the bar and is kept.
 */
export const ECHO_DEDUPE_TIGHT_COVERAGE = 0.5
/**
 * GARBLE tier token floor: the relaxed bar only applies to mic fragments with at least this many unique
 * tokens — higher than the global backchannel guard, so a short coincidental half-overlap ("meeting at
 * three maybe") can never trip it. Long enough that >=50% coverage within 750ms is a bleed signature.
 */
export const ECHO_DEDUPE_TIGHT_MIN_MIC_TOKENS = 5
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

/**
 * Is this mic/system pair an echo, given how far apart they were captured (deltaMs, absolute)? Two tiers:
 * the CONFIDENT tier (Jaccard >= 0.8 or full mic containment, within the 2s window) and the GARBLE tier
 * (directional mic-coverage >= 0.5 for a >=5-token mic fragment, within the tight 750ms window). Intersection
 * is counted once and shared by both. The garble tier is a strict SUPERSET catch — it only ever fires on
 * pairs the confident tier already rejected — so it can widen the catch but never change a confident verdict.
 */
const isNearDuplicate = (mic: ReadonlySet<string>, system: ReadonlySet<string>, deltaMs: number): boolean => {
  let intersection = 0
  for (const token of mic) if (system.has(token)) intersection += 1
  if (deltaMs <= ECHO_DEDUPE_WINDOW_MS) {
    if (intersection === mic.size) return true // full directional containment
    const union = mic.size + system.size - intersection
    if (union > 0 && intersection / union >= ECHO_DEDUPE_SIMILARITY) return true
  }
  // GARBLE tier: near-simultaneous + a long-enough mic fragment mostly covered by the system line.
  if (deltaMs <= ECHO_DEDUPE_TIGHT_WINDOW_MS && mic.size >= ECHO_DEDUPE_TIGHT_MIN_MIC_TOKENS) {
    if (intersection / mic.size >= ECHO_DEDUPE_TIGHT_COVERAGE) return true
  }
  return false
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
 * all of a drain's system fragments before checking any of its mic fragments). This asymmetry is ALIGNED
 * with the physics rather than a gap worth speculative backward buffering: acoustic bleed LAGS the playback
 * it copies (the speaker plays, then the mic hears it), so a bled twin's capturedAt is >= its system twin's,
 * and the 30s buffer persists across drains — so the system twin is essentially always already buffered when
 * the mic twin is checked. Retroactive backward repair would mean holding mic output back (a latency cost)
 * to cover an order-inversion that near-simultaneous bleed does not produce; deliberately not added (see
 * PHASE4-NOTES). The garble tier below inherits the same forward-only property unchanged.
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
      const deltaMs = Math.abs(capturedAt - candidate.capturedAt)
      if (deltaMs > ECHO_DEDUPE_WINDOW_MS) continue // beyond the widest (confident) window — no tier can match
      if (isNearDuplicate(mic, candidate.tokens, deltaMs)) {
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
