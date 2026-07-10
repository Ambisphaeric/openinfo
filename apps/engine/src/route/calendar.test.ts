import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeCalendarSample } from './calendar.js'
import { CalendarPoller } from './calendar-collector.js'
import type { TimedCalendarSignal } from './detector.js'

const AT = '2026-07-08T15:00:00.000Z'

// ---- decodeCalendarSample (pure) ----

test('decode: a well-formed events array → timed calendar signals stamped with the capture time', () => {
  const raw = JSON.stringify([
    { eventTitle: 'Acme sales sync', attendees: ['Dana Ret', 'dana@acme.com'], calendarName: 'Work', startsAt: '2026-07-08T15:00:00Z', endsAt: '2026-07-08T15:30:00Z' },
  ])
  const out = decodeCalendarSample(raw, AT)
  assert.equal(out.length, 1)
  assert.equal(out[0]!.at, AT)
  assert.deepEqual(out[0]!.signal, {
    eventTitle: 'Acme sales sync',
    attendees: ['Dana Ret', 'dana@acme.com'],
    calendarName: 'Work',
    startsAt: '2026-07-08T15:00:00Z',
    endsAt: '2026-07-08T15:30:00Z',
  })
})

test('decode: optional fields are OMITTED (not undefined) so a minimal event still validates', () => {
  const out = decodeCalendarSample(JSON.stringify([{ eventTitle: 'Focus block' }]), AT)
  assert.equal(out.length, 1)
  assert.deepEqual(Object.keys(out[0]!.signal), ['eventTitle'])
})

test('decode: attendees are trimmed and empties dropped; an empty list omits the field', () => {
  const out = decodeCalendarSample(JSON.stringify([{ eventTitle: '1:1', attendees: ['  Sam  ', '', '   '] }]), AT)
  assert.deepEqual(out[0]!.signal.attendees, ['Sam'])
  const none = decodeCalendarSample(JSON.stringify([{ eventTitle: '1:1', attendees: [] }]), AT)
  assert.equal(none[0]!.signal.attendees, undefined)
})

test('decode: a titleless event is skipped (not matchable context), others survive', () => {
  const logs: string[] = []
  const out = decodeCalendarSample(JSON.stringify([{ attendees: ['x'] }, { eventTitle: 'Real' }]), AT, (m) => logs.push(m))
  assert.deepEqual(out.map((s) => s.signal.eventTitle), ['Real'])
  assert.equal(logs.length, 1)
})

test('decode: an unparseable date drops just that field, keeping the signal', () => {
  const out = decodeCalendarSample(JSON.stringify([{ eventTitle: 'X', startsAt: 'not-a-date' }]), AT)
  assert.equal(out.length, 1)
  assert.equal(out[0]!.signal.startsAt, undefined)
})

test('decode: non-JSON and non-array payloads yield [] (logged, never thrown)', () => {
  const logs: string[] = []
  assert.deepEqual(decodeCalendarSample('}{not json', AT, (m) => logs.push(m)), [])
  assert.deepEqual(decodeCalendarSample(JSON.stringify({ eventTitle: 'not an array' }), AT, (m) => logs.push(m)), [])
  assert.equal(logs.length, 2)
})

// ---- CalendarPoller (lifecycle, edge injected) ----

interface Recorder {
  samples: number
  observed: TimedCalendarSignal[][]
}

const pollerWith = (opts: { enabled: boolean; sample: () => Promise<string | undefined> }) => {
  const rec: Recorder = { samples: 0, observed: [] }
  const poller = new CalendarPoller({
    sample: () => {
      rec.samples += 1
      return opts.sample()
    },
    isEnabled: () => opts.enabled,
    observe: async (signals) => {
      rec.observed.push([...signals])
    },
    now: () => new Date(AT),
  })
  return { poller, rec }
}

test('poller: OFF (route.detect) → never samples the OS and never observes (the privacy gate)', async () => {
  const { poller, rec } = pollerWith({ enabled: false, sample: async () => JSON.stringify([{ eventTitle: 'M' }]) })
  await poller.tick()
  assert.equal(rec.samples, 0)
  assert.equal(rec.observed.length, 0)
})

test('poller: ON + a current event → decodes and feeds the detector with the poll capture time', async () => {
  const { poller, rec } = pollerWith({ enabled: true, sample: async () => JSON.stringify([{ eventTitle: 'Standup', attendees: ['a@b.co'] }]) })
  await poller.tick()
  assert.equal(rec.samples, 1)
  assert.equal(rec.observed.length, 1)
  assert.equal(rec.observed[0]!.length, 1)
  assert.equal(rec.observed[0]![0]!.at, AT)
  assert.equal(rec.observed[0]![0]!.signal.eventTitle, 'Standup')
})

test('poller: ON but no access / no event (undefined) → samples, observes nothing, no throw', async () => {
  const { poller, rec } = pollerWith({ enabled: true, sample: async () => undefined })
  await poller.tick()
  assert.equal(rec.samples, 1)
  assert.equal(rec.observed.length, 0)
})

test('poller: a throwing sampler is swallowed (the loop survives a bad calendar read)', async () => {
  const { poller, rec } = pollerWith({ enabled: true, sample: async () => { throw new Error('osascript blew up') } })
  await poller.tick()
  assert.equal(rec.observed.length, 0)
})

test('poller: an empty events array observes nothing', async () => {
  const { poller, rec } = pollerWith({ enabled: true, sample: async () => '[]' })
  await poller.tick()
  assert.equal(rec.samples, 1)
  assert.equal(rec.observed.length, 0)
})

// ---- cold-boot readiness gate (#115) ----

test('poller: cold-boot gate HOLDS the first sample until isReady() (a transcript has landed)', async () => {
  let ready = false
  const rec = { samples: 0 }
  const poller = new CalendarPoller({
    sample: async () => { rec.samples += 1; return '[]' },
    isEnabled: () => true,
    isReady: () => ready,
    observe: async () => undefined,
    now: () => new Date(AT),
  })
  // Not ready → the first Calendar.app query is HELD (no TCC prompt during the messy first session).
  await poller.tick()
  await poller.tick()
  assert.equal(rec.samples, 0)
  // A transcript lands → the gate opens and the sample proceeds.
  ready = true
  await poller.tick()
  assert.equal(rec.samples, 1)
  // Once warmed up the gate is never consulted again — a later isReady()===false does NOT re-gate.
  ready = false
  await poller.tick()
  assert.equal(rec.samples, 2)
})

test('poller: the cold-boot gate RELEASES after the grace window even if isReady never goes true (calendar-only routing is not stranded)', async () => {
  const rec = { samples: 0 }
  const poller = new CalendarPoller({
    sample: async () => { rec.samples += 1; return '[]' },
    isEnabled: () => true,
    isReady: () => false, // no mic, so a transcript never arrives
    readyGraceMs: 0, // grace already elapsed → the first sample proceeds anyway
    observe: async () => undefined,
    now: () => new Date(AT),
  })
  await poller.tick()
  assert.equal(rec.samples, 1)
})

test('poller: the readiness gate never overrides the privacy gate (route.detect OFF → still no sample)', async () => {
  const rec = { samples: 0 }
  const poller = new CalendarPoller({
    sample: async () => { rec.samples += 1; return '[]' },
    isEnabled: () => false,
    isReady: () => true,
    readyGraceMs: 0,
    observe: async () => undefined,
    now: () => new Date(AT),
  })
  await poller.tick()
  assert.equal(rec.samples, 0)
})
