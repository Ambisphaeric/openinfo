import { test } from 'node:test'
import assert from 'node:assert/strict'
import { backoffMs, bootStatusText, createBootController, BOOT_BACKOFF_MS } from './boot.js'

/**
 * The boot controller is the fix for the invisible-HUD failure class: the packaged shell creates the
 * transparent HUD window BEFORE its bundled engine finishes spawning, the renderer's one-shot fetch lost
 * that race, and `void hud.start()` swallowed the rejection — a permanently blank window. These assert
 * the retry ladder, the visible status line at every failure, the clean stop() between attempts, and the
 * runtime restart hook — all headless via injected start/stop/schedule.
 */

/** A manual scheduler: retries run only when the test says time passed. */
const manualScheduler = () => {
  const queue: Array<{ fn: () => void; ms: number }> = []
  return {
    schedule: (fn: () => void, ms: number) => queue.push({ fn, ms }),
    /** run the next scheduled retry, returning its delay */
    tick: (): number | undefined => {
      const next = queue.shift()
      if (!next) return undefined
      next.fn()
      return next.ms
    },
    pending: () => queue.length,
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

test('backoffMs walks the ladder and caps at its last rung forever', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 20].map(backoffMs), [500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000])
  assert.equal(BOOT_BACKOFF_MS.length, 5)
})

test('bootStatusText names the engine, the reason, and the attempt', () => {
  const text = bootStatusText('http://127.0.0.1:8787', 3, new Error('Failed to fetch'))
  assert.match(text, /waiting for engine at http:\/\/127\.0\.0\.1:8787/)
  assert.match(text, /Failed to fetch/)
  assert.match(text, /retry 3/)
})

test('spawn race: start fails until the engine appears — status painted each failure, cleared on success', async () => {
  const sched = manualScheduler()
  const statuses: (string | null)[] = []
  let stops = 0
  let failuresLeft = 2
  const controller = createBootController({
    start: () => (failuresLeft-- > 0 ? Promise.reject(new Error('Failed to fetch')) : Promise.resolve()),
    stop: () => {
      stops += 1
    },
    onStatus: (text) => statuses.push(text),
    engineLabel: 'http://127.0.0.1:8787',
    schedule: sched.schedule,
  })

  controller.boot()
  await flush()
  // first failure: visible status, retry scheduled at the first rung
  assert.equal(statuses.length, 1)
  assert.match(statuses[0]!, /retry 1/)
  assert.equal(stops, 1, 'a failed attempt tears down any partial subscription')
  assert.equal(sched.tick(), 500)
  await flush()
  // second failure: attempt counter advances, second rung
  assert.match(statuses[1]!, /retry 2/)
  assert.equal(sched.tick(), 1_000)
  await flush()
  // engine is up: status cleared (null), nothing else scheduled
  assert.equal(statuses[2], null)
  assert.equal(sched.pending(), 0)
  assert.equal(stops, 2)
})

test('restart(err) after a successful boot shows the failure and re-enters the retry loop', async () => {
  const sched = manualScheduler()
  const statuses: (string | null)[] = []
  let startCalls = 0
  const controller = createBootController({
    start: () => {
      startCalls += 1
      return Promise.resolve()
    },
    stop: () => {},
    onStatus: (text) => statuses.push(text),
    engineLabel: 'http://box:8787',
    schedule: sched.schedule,
  })
  controller.boot()
  await flush()
  assert.deepEqual(statuses, [null])

  // the engine vanishes mid-session: a WS-triggered refresh rejects → restart
  controller.restart(new Error('engine gone'))
  assert.match(statuses[1]!, /engine gone/)
  sched.tick()
  await flush()
  assert.equal(startCalls, 2, 'restart re-runs start()')
  assert.equal(statuses[2], null, 'recovery clears the status')
})

test('boot() is idempotent while an attempt is in flight (no double start)', async () => {
  let startCalls = 0
  let release: () => void = () => {}
  const controller = createBootController({
    start: () => {
      startCalls += 1
      return new Promise((resolve) => {
        release = resolve
      })
    },
    stop: () => {},
    onStatus: () => {},
    engineLabel: 'x',
    schedule: () => {},
  })
  controller.boot()
  controller.boot()
  controller.restart(new Error('ignored while in flight'))
  release()
  await flush()
  assert.equal(startCalls, 1)
})
