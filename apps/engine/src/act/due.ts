/**
 * Deadline resolution for the to-do capture path (#179 opener). The task-extract model MAY propose a
 * `due` per item; the engine — never the model — decides whether it stands. Two derivation paths, both
 * validated against one sane horizon:
 *
 *  - `model`: the model emitted an absolute time. We accept it ONLY if it parses as ISO and lands inside
 *    the horizon. A model's ISO is a PROPOSAL, so an unparseable or out-of-horizon value is dropped (the
 *    item keeps, just without a fabricated deadline).
 *  - `anchored`: the model gave no usable time, so we deterministically resolve a plain relative
 *    expression ("in eighteen minutes", "in 2 hours") found in the item text against the extraction
 *    wall-clock. This is the safety net that makes the flagship case work on weak local models, which
 *    routinely echo the spoken phrase into the task text but cannot compute an ISO instant.
 *
 * Nothing is invented: no expression + no valid model time ⇒ no due.
 */

/**
 * The acceptance horizon, measured from the extraction wall-clock (the anchor):
 *  - not earlier than 60s BEFORE the anchor. A deadline captured "now" cannot legitimately already be in
 *    the past; the 60s slack only absorbs clock skew between the spoken moment and the drain that extracts it.
 *  - not later than 60 DAYS after the anchor. The #179 opener targets near-term, watch-able commitments;
 *    a due weeks-to-months out is far more likely a mis-parse (a hallucinated calendar date / wrong year)
 *    than a live meeting deadline, so we drop it rather than surface a bogus far-future time.
 */
export const DUE_PAST_SLACK_MS = 60_000
export const DUE_MAX_HORIZON_MS = 60 * 24 * 60 * 60_000

/** Whole-number words 0–19 (the ones + teens), for resolving spoken relative times deterministically. */
const ONES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
}
/** The tens (20–90), which may stand alone or lead a compound like "forty-five". */
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
}

/** Milliseconds per relative-time unit the deterministic fallback understands. */
const UNIT_MS: Record<string, number> = {
  minute: 60_000, min: 60_000,
  hour: 3_600_000, hr: 3_600_000,
  day: 86_400_000,
}

/**
 * Parse a spelled-out or numeric quantity ("eighteen", "forty-five", "20") into a non-negative integer,
 * or undefined if it is not a plain quantity we resolve. Handles a/an = 1, ones, teens, tens, and simple
 * tens+ones compounds ("twenty five" / "twenty-five"). Deliberately bounded — anything fancier is left to
 * the model's own ISO output.
 */
const parseQuantity = (raw: string): number | undefined => {
  const t = raw.trim().toLowerCase()
  if (t.length === 0) return undefined
  if (/^\d+$/.test(t)) return Number(t)
  if (t === 'a' || t === 'an') return 1
  const parts = t.split(/[\s-]+/).filter((p) => p.length > 0)
  if (parts.length === 1) {
    const w = parts[0]!
    if (w in ONES) return ONES[w]
    if (w in TENS) return TENS[w]
    return undefined
  }
  if (parts.length === 2 && parts[0]! in TENS && parts[1]! in ONES && ONES[parts[1]!]! < 10) {
    return TENS[parts[0]!]! + ONES[parts[1]!]!
  }
  return undefined
}

/** Normalize a unit token ("minutes"/"mins"/"hr") to its UNIT_MS key, or undefined. */
const unitKey = (raw: string): string | undefined => {
  const u = raw.trim().toLowerCase().replace(/s$/, '')
  if (u === 'mins') return 'min'
  return u in UNIT_MS ? u : undefined
}

// "in <quantity> <unit>" — the trivial spoken form. Quantity is digits or up to two number-words.
const RELATIVE_RE = /\bin\s+((?:\d+)|(?:[a-z]+(?:[\s-][a-z]+)?))\s+(minutes?|mins?|min|hours?|hrs?|hr|days?)\b/i

const withinHorizon = (dueMs: number, anchorMs: number): boolean =>
  dueMs >= anchorMs - DUE_PAST_SLACK_MS && dueMs <= anchorMs + DUE_MAX_HORIZON_MS

export interface ResolveDueInput {
  /** the model's proposed `due` for this item, if any (a bare string off the JSON candidate). */
  modelDue?: unknown
  /** the item's own text — scanned for a relative expression when no valid model time is present. */
  text: string
  /** the extraction wall-clock: relative expressions resolve against this, and it bounds the horizon. */
  anchor: Date
}

export interface ResolvedDue {
  due?: string
  dueSource?: 'model' | 'anchored'
}

/**
 * Resolve an item's deadline. Model ISO wins when valid; otherwise a deterministic relative-time fallback
 * over the text; otherwise nothing. The returned `due` is always a validated, in-horizon ISO string.
 */
export const resolveDue = (input: ResolveDueInput): ResolvedDue => {
  const anchorMs = input.anchor.getTime()

  // 1) Model proposal: accept a parseable, in-horizon ISO instant verbatim.
  if (typeof input.modelDue === 'string' && input.modelDue.trim().length > 0) {
    const parsed = new Date(input.modelDue.trim())
    const ms = parsed.getTime()
    if (!Number.isNaN(ms) && withinHorizon(ms, anchorMs)) {
      return { due: parsed.toISOString(), dueSource: 'model' }
    }
  }

  // 2) Deterministic fallback: resolve a plain "in N <unit>" against the anchor.
  const match = RELATIVE_RE.exec(input.text)
  if (match) {
    const qty = parseQuantity(match[1]!)
    const unit = unitKey(match[2]!)
    if (qty !== undefined && unit !== undefined) {
      const dueMs = anchorMs + qty * UNIT_MS[unit]!
      if (withinHorizon(dueMs, anchorMs)) {
        return { due: new Date(dueMs).toISOString(), dueSource: 'anchored' }
      }
    }
  }

  return {}
}
