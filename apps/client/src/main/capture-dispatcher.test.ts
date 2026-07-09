import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureSourceKind } from '../capture/protocol.js'
import { CaptureDispatcher, type CaptureDispatcherDeps, type DispatchChannel, type TimerHandle } from './capture-dispatcher.js'

/** A controllable timer harness: capture scheduled callbacks and fire them on demand (no real clock). */
const timerHarness = () => {
  const pending = new Map<TimerHandle, () => void>()
  let next = 0
  return {
    setTimer: (fn: () => void): TimerHandle => {
      const h = ++next
      pending.set(h, fn)
      return h
    },
    clearTimer: (h: TimerHandle) => void pending.delete(h),
    /** Fire every currently-scheduled timer once (resends may schedule fresh ones). */
    fireAll: () => {
      const snapshot = [...pending.entries()]
      pending.clear()
      for (const [, fn] of snapshot) fn()
    },
    get size() {
      return pending.size
    },
  }
}

const harness = (over: Partial<CaptureDispatcherDeps> = {}) => {
  const sends: Array<{ channel: DispatchChannel; source: CaptureSourceKind }> = []
  const faults: Array<{ source: CaptureSourceKind; reason: string }> = []
  const timers = timerHarness()
  const dispatcher = new CaptureDispatcher({
    send: (channel, source) => sends.push({ channel, source }),
    onFault: (source, reason) => faults.push({ source, reason }),
    log: () => {},
    ackTimeoutMs: 1000,
    maxRetries: 3,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...over,
  })
  return { dispatcher, sends, faults, timers }
}

test('dropped-start fix: a start before the renderer loads is QUEUED, never sent, then flushed on load', () => {
  const h = harness()
  h.dispatcher.requestStart('mic')
  assert.deepEqual(h.sends, []) // NOT sent — this is exactly the send that used to be silently dropped
  assert.equal(h.dispatcher.rendererLoaded, false)

  h.dispatcher.markLoaded()
  assert.deepEqual(h.sends, [{ channel: 'start', source: 'mic' }]) // delivered once the listener exists
})

test('once loaded a start is sent immediately and awaits an ack', () => {
  const h = harness()
  h.dispatcher.markLoaded()
  h.dispatcher.requestStart('mic')
  assert.deepEqual(h.sends, [{ channel: 'start', source: 'mic' }])
  assert.equal(h.timers.size, 1) // an ack timeout is armed

  h.dispatcher.ackStart('mic')
  assert.equal(h.timers.size, 0) // ack clears the timeout — no resend, no fault
  h.timers.fireAll()
  assert.deepEqual(h.faults, [])
})

test('missing ack resends up to maxRetries, then surfaces ONE visible fault', () => {
  const h = harness() // maxRetries 3
  h.dispatcher.markLoaded()
  h.dispatcher.requestStart('mic')
  // Each timeout with no ack resends; after maxRetries resends the next timeout faults.
  h.timers.fireAll() // resend #1
  h.timers.fireAll() // resend #2
  h.timers.fireAll() // resend #3
  assert.equal(h.sends.filter((s) => s.channel === 'start').length, 4) // initial + 3 resends
  assert.equal(h.faults.length, 0) // not yet — still within the retry budget
  h.timers.fireAll() // 5th timeout: attempts (4) > maxRetries (3) → fault
  assert.deepEqual(h.faults.map((f) => f.source), ['mic'])
  h.timers.fireAll() // no more timers armed → no duplicate fault
  assert.equal(h.faults.length, 1)
})

test('an ack that lands after a resend stops the retry loop (no fault)', () => {
  const h = harness()
  h.dispatcher.markLoaded()
  h.dispatcher.requestStart('mic')
  h.timers.fireAll() // resend #1
  h.dispatcher.ackStart('mic') // renderer finally acked
  h.timers.fireAll()
  assert.deepEqual(h.faults, [])
  assert.equal(h.timers.size, 0)
})

test('requestStop cancels a pending start ack-wait and sends stop (no dangling timer, no fault)', () => {
  const h = harness()
  h.dispatcher.markLoaded()
  h.dispatcher.requestStart('mic')
  assert.equal(h.timers.size, 1)
  h.dispatcher.requestStop('mic')
  assert.deepEqual(h.sends, [
    { channel: 'start', source: 'mic' },
    { channel: 'stop', source: 'mic' },
  ])
  assert.equal(h.timers.size, 0)
  h.timers.fireAll()
  assert.deepEqual(h.faults, []) // the cancelled start never faults
})

test('renderer-gone re-queues an in-flight start so it re-fires (not drops) when the renderer returns', () => {
  const h = harness()
  h.dispatcher.markLoaded()
  h.dispatcher.requestStart('mic')
  h.dispatcher.markUnloaded('render-process-gone')
  assert.equal(h.dispatcher.rendererLoaded, false)
  assert.equal(h.timers.size, 0) // the ack timer was dropped, not left dangling
  h.dispatcher.markLoaded() // renderer reloaded
  assert.equal(h.sends.filter((s) => s.channel === 'start').length, 2) // re-fired, never silently lost
})

test('a stale ack after stop is ignored (no state corruption)', () => {
  const h = harness()
  h.dispatcher.markLoaded()
  h.dispatcher.requestStart('mic')
  h.dispatcher.requestStop('mic')
  assert.doesNotThrow(() => h.dispatcher.ackStart('mic'))
  h.timers.fireAll()
  assert.deepEqual(h.faults, [])
})

test('two audio sources are tracked independently', () => {
  const h = harness()
  h.dispatcher.markLoaded()
  h.dispatcher.requestStart('mic')
  h.dispatcher.requestStart('system-audio')
  h.dispatcher.ackStart('mic') // only mic acked
  // system-audio still awaits — its retry loop runs to a fault while mic stays quiet.
  h.timers.fireAll()
  h.timers.fireAll()
  h.timers.fireAll()
  h.timers.fireAll()
  assert.deepEqual(
    h.faults.map((f) => f.source),
    ['system-audio'],
  )
})
