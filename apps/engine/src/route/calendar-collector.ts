import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isFlagEnabled } from '../flags/read.js'
import type { WorkspaceRegistry } from '../store/index.js'
import type { Attributor } from './attribute.js'
import { decodeCalendarSample } from './calendar.js'
import type { TimedCalendarSignal } from './detector.js'

const execFileAsync = promisify(execFile)

/**
 * The engine-side calendar collector — the thin macOS EDGE around the pure decode (calendar.ts) and the
 * detector (attribute.ts), mirroring the client's FocusPoller lifecycle but on the engine side (calendar
 * routing needs no renderer/getUserMedia, unlike focus which lives in the client's electron main). It runs
 * a modest poll timer that, while `route.detect` is ON, samples the current/imminent Calendar.app event via
 * osascript, decodes it, and feeds the resulting signals to the SAME Attributor the focus drain feeds — so
 * meeting presence and window/repo focus contest in one sustain window.
 *
 * WHY route.detect (not a dedicated flag): calendar is a routing SIGNAL of the same detection feature focus
 * is, so it rides the existing master opt-in rather than inventing a knob (the detector's config stays the
 * only dials — see DetectorConfig). Calendar.app access is a separate OS-level (TCC) consent regardless; a
 * denied read simply yields no signals.
 *
 * PRIVACY / DEGRADE: the flag is read PER-TICK, so no osascript ever runs while route.detect is OFF (the
 * timer wakes and immediately returns) — not sample-and-drop. A failed/denied/empty read yields no signals
 * and never throws: a bad calendar poll must not crash the loop or the engine.
 */

/** Poll cadence. Meetings change on the order of minutes, so poll modestly; several polls still land inside
 * the detector's 90s sustain window, letting an ongoing meeting sustain presence. */
export const CALENDAR_POLL_INTERVAL_MS = 30_000

/** Hard cap on one osascript sample so a slow/hung Calendar.app scripting call can't wedge the loop. */
export const CALENDAR_SAMPLE_TIMEOUT_MS = 15_000

/**
 * Cold-boot readiness grace (#115). The FIRST calendar sample is held behind the `isReady` gate (wired to
 * "a live transcript has landed") so a fresh machine does not pop Calendar.app / a TCC automation prompt
 * during the messy first session. But calendar routing must not be STRANDED when there is no mic activity
 * (a transcript may never arrive), so once this window elapses from start the first sample proceeds anyway.
 * Sized to the detector's sustain horizon so the gate never delays routing by more than one sustain window.
 */
export const CALENDAR_READY_GRACE_MS = 90_000

/** How far ahead an event counts as "imminent" — routes you into a meeting a few minutes before it starts. */
const IMMINENT_LEAD_MS = 5 * 60 * 1000

/**
 * JXA (osascript -l JavaScript) that emits a JSON array of the current/imminent Calendar.app events —
 * those already started (end in the future) or starting within IMMINENT_LEAD_MS. Best-effort and defensive:
 * a calendar or event that can't be read is skipped, never fatal; an empty result is a valid "[]".
 */
const CALENDAR_JXA = `
(() => {
  const cal = Application('Calendar')
  const now = new Date()
  const soon = new Date(now.getTime() + ${IMMINENT_LEAD_MS})
  const out = []
  let calendars
  try { calendars = cal.calendars() } catch (e) { return '[]' }
  for (let i = 0; i < calendars.length; i++) {
    let events
    try {
      events = calendars[i].events.whose({ _and: [ { startDate: { _lessThan: soon } }, { endDate: { _greaterThan: now } } ] })()
    } catch (e) { continue }
    for (let j = 0; j < events.length; j++) {
      const ev = events[j]
      const attendees = []
      try {
        const list = ev.attendees()
        for (let k = 0; k < list.length; k++) {
          try { const n = list[k].displayName(); if (n) attendees.push(n) } catch (e) {}
          try { const m = list[k].email(); if (m) attendees.push(m) } catch (e) {}
        }
      } catch (e) {}
      try {
        out.push({
          eventTitle: ev.summary(),
          attendees: attendees,
          calendarName: calendars[i].name(),
          startsAt: ev.startDate().toISOString(),
          endsAt: ev.endDate().toISOString(),
        })
      } catch (e) {}
    }
  }
  return JSON.stringify(out)
})()
`

/**
 * The default OS sampler — the ONE impure line. Runs the JXA above under osascript with a hard timeout, and
 * returns the raw JSON string, or undefined on ANY failure (Calendar not scriptable, TCC denied, timeout).
 * Injected into CalendarPoller so tests substitute a pure stub and never shell out.
 */
export const sampleCalendarViaOsascript = async (): Promise<string | undefined> => {
  try {
    const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', CALENDAR_JXA], {
      timeout: CALENDAR_SAMPLE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    })
    const trimmed = stdout.trim()
    return trimmed.length > 0 ? trimmed : undefined
  } catch {
    return undefined
  }
}

export interface CalendarPollerDeps {
  /**
   * Read the current/imminent Calendar.app event(s) from the OS (osascript in production, a stub in tests).
   * Returns the raw JSON string, or undefined when nothing can be read (denied/failed/empty) — the poller
   * then emits nothing rather than a partial signal. MUST NOT throw fatally (the poller guards it anyway).
   */
  sample: () => Promise<string | undefined>
  /** True iff calendar collection should run right now (the `route.detect` flag; read PER-TICK, hot-flippable). */
  isEnabled: () => boolean
  /**
   * Cold-boot gate for the FIRST sample only (#115): while this returns false the poller holds its first
   * Calendar.app query, so a fresh machine does not pop a TCC prompt during the first session. Wired to
   * "a first transcript has landed". Absent ⇒ ready immediately (existing behavior, all prior tests). Once
   * the first sample has run (gate satisfied OR the readyGrace window below elapsed) it is never consulted
   * again — steady-state polling is unchanged.
   */
  isReady?: () => boolean
  /** Fallback so calendar-only routing (no mic) is never stranded: proceed with the first sample this long
   * after start even if isReady never went true. Defaults to CALENDAR_READY_GRACE_MS. */
  readyGraceMs?: number
  /** Feed decoded signals into the shared detector buffer (the Attributor.observe the focus drain also calls). */
  observe: (signals: readonly TimedCalendarSignal[]) => Promise<unknown>
  /** Poll cadence; defaults to CALENDAR_POLL_INTERVAL_MS. */
  intervalMs?: number
  /** Clock for the capture time stamped on each signal; defaults to () => new Date(). */
  now?: () => Date
  log?: (message: string) => void
}

export class CalendarPoller {
  private timer: ReturnType<typeof setInterval> | undefined
  /** Reentrancy guard: an in-flight async sample must not overlap the next tick. */
  private sampling = false
  /** Cold-boot latch (#115): false until the first sample has been allowed through; then never re-gated. */
  private warmedUp = false
  private readonly startedAtMs = Date.now()
  private readonly intervalMs: number
  private readonly now: () => Date
  private readonly isReady: () => boolean
  private readonly readyGraceMs: number

  constructor(private readonly deps: CalendarPollerDeps) {
    this.intervalMs = deps.intervalMs ?? CALENDAR_POLL_INTERVAL_MS
    this.now = deps.now ?? (() => new Date())
    this.isReady = deps.isReady ?? (() => true)
    this.readyGraceMs = deps.readyGraceMs ?? CALENDAR_READY_GRACE_MS
  }

  /** Start the poll timer (idempotent). Unref'd so it never holds the process open on its own. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
    this.timer.unref?.()
    this.deps.log?.(`[calendar] watching meeting context (polling every ${this.intervalMs}ms while route.detect is ON)`)
  }

  /** Stop cleanly (engine teardown). Idempotent. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /**
   * One poll cycle — public so tests drive it directly without a real timer. Reads the flag (no OS access
   * when OFF — the privacy gate), samples, decodes, and feeds the detector. A no-op while a prior tick is
   * in flight; every failure is logged and swallowed so the loop survives.
   */
  async tick(): Promise<void> {
    if (this.sampling) return
    if (!this.deps.isEnabled()) return // privacy gate: never query Calendar.app while route.detect is OFF
    // Cold-boot gate (#115): hold the FIRST sample until a transcript has landed (or the grace window has
    // elapsed, so calendar-only routing is not stranded). Once warmed up this is never consulted again.
    if (!this.warmedUp) {
      if (this.isReady() || Date.now() - this.startedAtMs >= this.readyGraceMs) {
        this.warmedUp = true
      } else {
        return
      }
    }
    this.sampling = true
    try {
      let raw: string | undefined
      try {
        raw = await this.deps.sample()
      } catch (err) {
        this.deps.log?.(`[calendar] sample failed (ignored): ${String(err)}`)
        return
      }
      if (!raw) return // no access / no current event — emit nothing
      const signals = decodeCalendarSample(raw, this.now().toISOString(), this.deps.log)
      if (signals.length === 0) return
      try {
        await this.deps.observe(signals)
      } catch (err) {
        this.deps.log?.(`[calendar] observe failed (ignored): ${String(err)}`)
      }
    } finally {
      this.sampling = false
    }
  }
}

/** The engine surface startCalendarCollector needs — EngineApp is structurally compatible ({ store, attributor }). */
export interface CalendarWiringApp {
  store: WorkspaceRegistry
  attributor: Attributor
  /** Cold-boot gate (#115): the first sample is held until a live transcript has landed. Optional so a bare
   * app (older tests) with no such seam is ready immediately — steady-state behavior is unchanged. */
  firstTranscriptSeen?: () => boolean
}

export interface CalendarWiringOptions {
  log?: (message: string) => void
  /** test seam — a fake OS sampler standing in for osascript (no macOS needed). */
  sample?: () => Promise<string | undefined>
  intervalMs?: number
  now?: () => Date
  /** Override the cold-boot readiness grace (#115); defaults to CALENDAR_READY_GRACE_MS. */
  readyGraceMs?: number
}

/**
 * Mount + start the calendar collector on a running engine (main.ts calls this after createEngineApp; tests
 * wire the same way explicitly). Gates on `route.detect` read per-tick off the app store, and feeds the
 * app's Attributor — the ONE detector buffer the focus drain also feeds. Returns the poller so callers can
 * stop it on teardown. Mirrors screen/index.ts's wireScreenOcr(app, …) mount precedent.
 */
export const startCalendarCollector = (app: CalendarWiringApp, options: CalendarWiringOptions = {}): CalendarPoller => {
  const poller = new CalendarPoller({
    sample: options.sample ?? sampleCalendarViaOsascript,
    isEnabled: () => isFlagEnabled(app.store, 'route.detect'),
    observe: (signals) => app.attributor.observe(signals),
    // Cold-boot gate (#115): hold the first sample until a transcript has landed. Ready-immediately when
    // the app exposes no such seam, so nothing regresses for an app without the STT-track wiring.
    isReady: () => app.firstTranscriptSeen?.() ?? true,
    ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.readyGraceMs !== undefined ? { readyGraceMs: options.readyGraceMs } : {}),
    ...(options.log ? { log: options.log } : {}),
  })
  poller.start()
  return poller
}
