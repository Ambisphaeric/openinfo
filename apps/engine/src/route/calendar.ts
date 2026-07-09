import { CalendarSignal } from '@openinfo/contracts'
import { Value } from '@sinclair/typebox/value'
import type { TimedCalendarSignal } from './detector.js'

/**
 * Calendar signal decode — the PURE half of calendar collection, so all parsing/normalization is asserted
 * headless (no macOS, no osascript, no Calendar.app). The collector (calendar-collector.ts) owns the ONE
 * impure edge — the osascript sample of the current/imminent Calendar.app event — and hands its raw output
 * here; nothing in this file touches the OS. Mirrors the client's focus.ts (raw OS reading → typed signal)
 * rather than the engine's focus.ts (drained chunks → signals): calendar is collected engine-side and fed
 * DIRECTLY to the detector, not carried as a CaptureChunk (see CalendarSignal's contract note).
 *
 * The collector's sampler emits a JSON array of raw event objects (one per current/imminent event). Each
 * is normalized to a minimal CalendarSignal (optional fields OMITTED when empty so it validates under
 * additionalProperties:false) and contract-checked; a malformed sample or entry is SKIPPED (logged), never
 * thrown — a bad calendar read must never crash the poll loop or the engine. `at` is the poll's capture
 * time, so the detector windows calendar presence by observation time exactly as it does focus.
 */

/** Trim to a non-empty string, or undefined — the omit-when-empty rule for optional fields. */
const asString = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

/** A raw calendar time is kept only when it parses; the final Value.Check enforces the ISO date-time format. */
const asTime = (value: unknown): string | undefined => {
  const s = asString(value)
  return s !== undefined && !Number.isNaN(Date.parse(s)) ? s : undefined
}

/**
 * Normalize one raw event object into a minimal CalendarSignal, or undefined when it has no usable title
 * (a titleless event is not matchable context). Optional fields are set ONLY when present so the object
 * validates under the contract's additionalProperties:false. Attendees are trimmed and empties dropped.
 */
const normalizeEntry = (entry: unknown): CalendarSignal | undefined => {
  if (typeof entry !== 'object' || entry === null) return undefined
  const e = entry as Record<string, unknown>
  const eventTitle = asString(e['eventTitle'])
  if (eventTitle === undefined) return undefined
  const signal: CalendarSignal = { eventTitle }
  const attendees = Array.isArray(e['attendees'])
    ? e['attendees'].map(asString).filter((s): s is string => s !== undefined)
    : []
  if (attendees.length > 0) signal.attendees = attendees
  const calendarName = asString(e['calendarName'])
  if (calendarName !== undefined) signal.calendarName = calendarName
  const startsAt = asTime(e['startsAt'])
  if (startsAt !== undefined) signal.startsAt = startsAt
  const endsAt = asTime(e['endsAt'])
  if (endsAt !== undefined) signal.endsAt = endsAt
  return signal
}

/**
 * Decode a raw collector sample (a JSON array of event objects) into timed CalendarSignals stamped with the
 * poll's capture time `at`. Non-JSON, a non-array payload, or an entry that fails normalization/validation
 * is skipped (logged), never thrown. Returns [] on any wholesale failure — the collector then emits nothing.
 */
export const decodeCalendarSample = (
  raw: string,
  at: string,
  log: (message: string) => void = () => undefined,
): TimedCalendarSignal[] => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    log('calendar: sample was not JSON, skipped')
    return []
  }
  if (!Array.isArray(parsed)) {
    log('calendar: sample was not a JSON array, skipped')
    return []
  }
  const out: TimedCalendarSignal[] = []
  for (const entry of parsed) {
    const signal = normalizeEntry(entry)
    if (signal === undefined || !Value.Check(CalendarSignal, signal)) {
      log('calendar: event entry missing a title or failed validation, skipped')
      continue
    }
    out.push({ at, signal })
  }
  return out
}
