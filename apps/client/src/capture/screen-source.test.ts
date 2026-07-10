import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startScreenCadence } from './screen-source.js'

/**
 * The screen source honours the CONFIGURED cadence (issue #4). Mirrors the #57 renderer test's approach:
 * rather than wait on a wall clock, fake the global setInterval/clearInterval so the scheduled delay is
 * asserted instantly and the cadence tick is fired manually. This proves the screen loop grabs on exactly
 * the interval config.ts resolved+clamped into the 3–6s band — a cadence change is observable in behaviour,
 * not merely accepted.
 */

interface FakeTimer {
  fn: () => void
  ms: number
  handle: number
}

interface Harness {
  timers: FakeTimer[]
  cleared: number[]
  restore: () => void
}

/** Install spies on the global timers; startScreenCadence uses the globals (no injection), like #57. */
const installFakeTimers = (): Harness => {
  const timers: FakeTimer[] = []
  const cleared: number[] = []
  let nextHandle = 1
  const g = globalThis as unknown as Record<string, unknown>
  const originalSetInterval = g['setInterval']
  const originalClearInterval = g['clearInterval']

  g['setInterval'] = ((fn: () => void, ms?: number) => {
    const handle = nextHandle++
    timers.push({ fn, ms: ms ?? 0, handle })
    return handle as unknown as ReturnType<typeof setInterval>
  }) as typeof setInterval
  g['clearInterval'] = ((handle?: ReturnType<typeof setInterval>) => {
    cleared.push(handle as unknown as number)
  }) as typeof clearInterval

  return {
    timers,
    cleared,
    restore: () => {
      g['setInterval'] = originalSetInterval
      g['clearInterval'] = originalClearInterval
    },
  }
}

test('grabs one frame immediately, then schedules the loop at the configured interval (#4)', () => {
  const h = installFakeTimers()
  try {
    let grabs = 0
    const handle = startScreenCadence({ intervalMs: 4000, grab: () => void grabs++ })
    // The first frame is grabbed synchronously on start — not a full interval away.
    assert.equal(grabs, 1, 'a frame is grabbed immediately')
    // Exactly one timer, scheduled at the configured cadence (the value config.ts already clamped).
    assert.equal(h.timers.length, 1, 'one cadence timer was scheduled')
    assert.equal(h.timers[0]?.ms, 4000, 'the loop ticks at the configured interval, not a hardcode')
    // Firing the tick grabs another frame — the loop honours the cadence in behaviour.
    h.timers[0]?.fn()
    assert.equal(grabs, 2, 'each cadence tick grabs a frame')
    h.timers[0]?.fn()
    assert.equal(grabs, 3)
    handle.stop()
  } finally {
    h.restore()
  }
})

test('stop() clears the cadence timer and is idempotent (#4)', () => {
  const h = installFakeTimers()
  try {
    const handle = startScreenCadence({ intervalMs: 5000, grab: () => undefined })
    const scheduled = h.timers[0]?.handle
    handle.stop()
    assert.deepEqual(h.cleared, [scheduled], 'stop clears exactly the scheduled timer')
    handle.stop() // a second stop is a no-op (no double-clear)
    assert.deepEqual(h.cleared, [scheduled], 'stop is idempotent')
  } finally {
    h.restore()
  }
})

test('honours a fresh interval on the next start — a restart adopts a changed cadence (#4)', () => {
  const h = installFakeTimers()
  try {
    // A cadence change takes effect on the next start (stop → start), the path shell.ts drives on the
    // session lifecycle: no stale interval is carried over.
    startScreenCadence({ intervalMs: 3000, grab: () => undefined }).stop()
    startScreenCadence({ intervalMs: 6000, grab: () => undefined })
    assert.equal(h.timers.at(-1)?.ms, 6000, 'the restarted loop uses the new interval')
  } finally {
    h.restore()
  }
})
