import type { AttributionEvidence, AttributionPattern, CalendarSignal, FocusSignal, WorkspaceHints } from '@openinfo/contracts'

/**
 * A routing signal the detector scores — a FocusSignal (foreground window/repo) or a CalendarSignal
 * (current/imminent meeting). The two carry DISJOINT fields, so a hint pattern only matches the signal
 * type that carries its field; both flow through the ONE sustain-window scoring below.
 */
export type Signal = FocusSignal | CalendarSignal

/**
 * A FocusSignal with the wall-clock time it was captured (a focus CaptureChunk's `capturedAt`). The
 * detector reasons over an ordered stream of these — time, not arrival order, defines the window.
 */
export interface TimedFocusSignal {
  at: string
  signal: FocusSignal
}

/**
 * A CalendarSignal with the wall-clock time it was captured (the collector's poll time). Like a
 * TimedFocusSignal, `at` is CAPTURE time (when the meeting was observed to be current), not the event's
 * start — the detector windows by observation time so an ongoing meeting sustains presence.
 */
export interface TimedCalendarSignal {
  at: string
  signal: CalendarSignal
}

/** One timed routing signal in the detector's stream — focus or calendar. */
export type TimedSignal = TimedFocusSignal | TimedCalendarSignal

/**
 * The detector's tuning knobs (v0 constants; the ONLY place to tune sustain/thrash behavior).
 * Later slices (calendar/voice presence) add signal SOURCES, not knobs — these three stay the dials.
 */
export interface DetectorConfig {
  /** how long a candidate workspace must dominate before a switch fires (thrash resistance). */
  sustainMs: number
  /** the fraction of the trailing window a candidate must own to count as dominant. */
  dominanceShare: number
  /** a DETECTED attribution is never fully certain — confidence is capped below a manual 1.0. */
  maxConfidence: number
}

/** v0 defaults: 90s sustain, 60% dominance, 0.9 confidence cap. Documented in PHASE3-NOTES. */
export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  sustainMs: 90_000,
  dominanceShare: 0.6,
  maxConfidence: 0.9,
}

export interface DetectionResult {
  decision: 'stay' | 'switch'
  /** the winning workspace, present only on a 'switch'. */
  toWorkspaceId?: string
  /** the matched-hint evidence for the winner (empty on 'stay'). */
  evidence: AttributionEvidence[]
  /** window-dominance confidence, always < 1 (capped at maxConfidence). */
  confidence: number
}

const ms = (iso: string): number => Date.parse(iso)

/** repoPath → 'repo'; eventTitle/attendee → 'calendar'; windowTitle/app → 'window'. (voice: P7). */
const evidenceKind = (field: AttributionPattern['field']): AttributionEvidence['kind'] =>
  field === 'repoPath' ? 'repo' : field === 'eventTitle' || field === 'attendee' ? 'calendar' : 'window'

const detailOf = (p: AttributionPattern): string => {
  const how = p.contains !== undefined ? `contains "${p.contains}"` : p.prefix !== undefined ? `prefix "${p.prefix}"` : 'matches'
  return `${p.field} ${how}`
}

/**
 * The candidate string(s) a pattern's field reads off a signal: one for the scalar focus/calendar fields,
 * the whole attendee list for `attendee` (any attendee may satisfy the matcher). A field the signal type
 * doesn't carry (a focus field on a calendar signal, or vice-versa) yields none — patterns only match
 * their own signal type, since the two field sets are disjoint.
 */
const fieldValues = (field: AttributionPattern['field'], signal: Signal): string[] => {
  if (field === 'attendee') {
    const attendees = (signal as CalendarSignal).attendees
    return Array.isArray(attendees) ? attendees : []
  }
  const value = (signal as Record<string, unknown>)[field]
  return typeof value === 'string' ? [value] : []
}

/** Does one pattern match one signal? Case-insensitive; when both matchers are set, both must hold. */
const patternMatches = (pattern: AttributionPattern, signal: Signal): boolean => {
  if (pattern.contains === undefined && pattern.prefix === undefined) return false
  return fieldValues(pattern.field, signal).some((raw) => {
    const haystack = raw.toLowerCase()
    if (pattern.contains !== undefined && !haystack.includes(pattern.contains.toLowerCase())) return false
    if (pattern.prefix !== undefined && !haystack.startsWith(pattern.prefix.toLowerCase())) return false
    return true
  })
}

/** The matching patterns of one workspace's hints against one signal (empty ⇒ no match). */
const matchingPatterns = (hints: WorkspaceHints, signal: Signal): AttributionPattern[] =>
  hints.patterns.filter((p) => patternMatches(p, signal))

/** Sum of matched-pattern weights — one signal's score for one workspace. */
const scoreFor = (hints: WorkspaceHints, signal: Signal): number =>
  matchingPatterns(hints, signal).reduce((sum, p) => sum + p.weight, 0)

/**
 * Pure context-switch detection (Detector v0). Given an ordered stream of timed signals (FocusSignals
 * and/or CalendarSignals — both scored the same way, one buffer), every workspace's attribution hints,
 * and the workspace the user is CURRENTLY attributed to (the live
 * session's workspace, or undefined when nothing is live), decide whether the day has segmented into
 * a new workspace.
 *
 * SUSTAIN-WINDOW SEMANTICS (the anti-thrash core): a switch fires only when a single workspace
 * DOMINATES the trailing `sustainMs` window. Concretely:
 *  - There must be at least `sustainMs` of observation (the buffer must span the window) — a brief
 *    burst of signals can never trigger a switch, and a fresh boot must watch for the full window
 *    before auto-starting.
 *  - Each signal in the trailing window is attributed to its single best-scoring workspace (a tie or
 *    a zero score ⇒ that signal is unattributed and only dilutes).
 *  - The dominant workspace must own ≥ `dominanceShare` of ALL windowed signals (unattributed and
 *    ambiguous signals count against the share) AND differ from the current one.
 * A brief alt-tab therefore can't flip attribution (it never accrues the share over a full window),
 * and an even split between two workspaces stays put (neither reaches the share). Deterministic:
 * identical input ⇒ identical output, so it is unit-tested against synthetic streams.
 *
 * `confidence` is the winner's window share, capped at `maxConfidence` (< 1) — a detected attribution
 * is never as certain as a manual one (which the reroute correction loop stamps at 1.0). `evidence`
 * is the distinct matched hints of the winner across the window, as AttributionEvidence.
 */
export function detectSwitch(
  signals: readonly TimedSignal[],
  hints: readonly WorkspaceHints[],
  currentWorkspaceId: string | undefined,
  config: DetectorConfig = DEFAULT_DETECTOR_CONFIG,
): DetectionResult {
  const stay: DetectionResult = { decision: 'stay', evidence: [], confidence: 0 }
  if (signals.length === 0) return stay

  const ordered = [...signals].sort((a, b) => ms(a.at) - ms(b.at))
  const last = ms(ordered[ordered.length - 1]!.at)
  const first = ms(ordered[0]!.at)
  // Require a full sustain window of observation before any switch — the buffer must span sustainMs.
  if (last - first < config.sustainMs) return stay

  const windowStart = last - config.sustainMs
  const windowed = ordered.filter((s) => ms(s.at) >= windowStart)
  if (windowed.length === 0) return stay

  // Attribute each windowed signal to its single best-scoring workspace (tie/zero ⇒ unattributed).
  const winsByWorkspace = new Map<string, number>()
  for (const { signal } of windowed) {
    let bestId: string | undefined
    let bestScore = 0
    let tied = false
    for (const h of hints) {
      const score = scoreFor(h, signal)
      if (score > bestScore) {
        bestScore = score
        bestId = h.workspaceId
        tied = false
      } else if (score === bestScore && score > 0) {
        tied = true
      }
    }
    if (bestId !== undefined && bestScore > 0 && !tied) {
      winsByWorkspace.set(bestId, (winsByWorkspace.get(bestId) ?? 0) + 1)
    }
  }

  let dominantId: string | undefined
  let dominantWins = 0
  for (const [id, wins] of winsByWorkspace) {
    if (wins > dominantWins) {
      dominantWins = wins
      dominantId = id
    }
  }
  if (dominantId === undefined) return stay

  const share = dominantWins / windowed.length
  if (share < config.dominanceShare) return stay
  if (dominantId === currentWorkspaceId) return stay

  // Collect the winner's distinct matched hints across the window as evidence.
  const winnerHints = hints.find((h) => h.workspaceId === dominantId)!
  const seen = new Set<string>()
  const evidence: AttributionEvidence[] = []
  for (const { signal } of windowed) {
    for (const p of matchingPatterns(winnerHints, signal)) {
      const key = `${evidenceKind(p.field)}:${detailOf(p)}`
      if (seen.has(key)) continue
      seen.add(key)
      evidence.push({ kind: evidenceKind(p.field), detail: detailOf(p), weight: p.weight })
    }
  }

  return {
    decision: 'switch',
    toWorkspaceId: dominantId,
    evidence,
    confidence: Math.min(share, config.maxConfidence),
  }
}
