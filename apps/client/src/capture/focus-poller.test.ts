import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk } from '@openinfo/contracts'
import { FocusPoller, detectEnabledFrom, ROUTE_DETECT_FLAG, type FocusPollerDeps } from './focus-poller.js'
import type { FrontmostWindow } from './focus.js'

/** A poller wired to a scripted sample source + a captured clock, so ticks are driven deterministically. */
const harness = (over: Partial<FocusPollerDeps> = {}) => {
  const emitted: CaptureChunk[] = []
  const active: boolean[] = []
  let sample: FrontmostWindow | undefined
  let clock = 100_000
  const poller = new FocusPoller({
    sample: async () => sample,
    emit: async (chunk) => void emitted.push(chunk),
    workspaceId: 'default',
    runId: 'run',
    enabled: true,
    intervalMs: 3000,
    minEmitIntervalMs: 1000,
    now: () => clock,
    onActiveChange: (a) => active.push(a),
    ...over,
  })
  return {
    poller,
    emitted,
    active,
    setWindow: (w: FrontmostWindow | undefined) => (sample = w),
    advance: (ms: number) => (clock += ms),
  }
}

test('detectEnabledFrom reads the route.detect flag default; a missing flag is OFF', () => {
  assert.equal(detectEnabledFrom([{ key: ROUTE_DETECT_FLAG, default: true }]), true)
  assert.equal(detectEnabledFrom([{ key: ROUTE_DETECT_FLAG, default: false }]), false)
  assert.equal(detectEnabledFrom([{ key: 'distill.enabled', default: true }]), false) // route.detect absent
  assert.equal(detectEnabledFrom([]), false)
})

test('no polling when the flag is off — a tick before the flag flips emits nothing', async () => {
  const h = harness()
  h.setWindow({ app: 'Code', windowTitle: 'a.ts — repo' })
  assert.equal(h.poller.isActive, false)
  await h.poller.tick() // not active — must be a no-op
  assert.equal(h.emitted.length, 0)
})

test('flag ON activates the loop and the immediate first tick announces the current window', async () => {
  const h = harness()
  h.setWindow({ app: 'Code', windowTitle: 'a.ts — repo' })
  h.poller.setDetectEnabled(true)
  assert.equal(h.poller.isActive, true)
  assert.deepEqual(h.active, [true]) // onActiveChange fired once, true
  await new Promise((r) => setImmediate(r)) // let the startLoop's immediate tick settle
  assert.equal(h.emitted.length, 1)
  assert.equal(h.emitted[0]?.source, 'focus')
  assert.deepEqual(JSON.parse(h.emitted[0]!.data), { app: 'Code', windowTitle: 'a.ts — repo', repoPath: 'repo' })
  h.poller.stop()
})

test('dedupe — an unchanged context between ticks emits only once', async () => {
  const h = harness()
  h.setWindow({ app: 'Code', windowTitle: 'a.ts — repo' })
  h.poller.setDetectEnabled(true)
  await new Promise((r) => setImmediate(r)) // immediate tick → 1 emit
  h.advance(3000)
  await h.poller.tick() // same window → no emit
  h.advance(3000)
  await h.poller.tick()
  assert.equal(h.emitted.length, 1)
  h.poller.stop()
})

test('a genuine change emits a new chunk with an incremented sequence', async () => {
  const h = harness()
  h.setWindow({ app: 'Code', windowTitle: 'a.ts — repo' })
  h.poller.setDetectEnabled(true)
  await new Promise((r) => setImmediate(r))
  h.advance(3000)
  h.setWindow({ app: 'Slack', windowTitle: 'general — Acme' })
  await h.poller.tick()
  assert.equal(h.emitted.length, 2)
  assert.equal(h.emitted[1]?.sequence, 2)
  assert.deepEqual(JSON.parse(h.emitted[1]!.data), { app: 'Slack', windowTitle: 'general — Acme' })
  h.poller.stop()
})

test('burst throttle — a change within the min-emit window is deferred, then emitted next tick', async () => {
  const h = harness()
  h.setWindow({ app: 'A', windowTitle: 'one' })
  h.poller.setDetectEnabled(true)
  await new Promise((r) => setImmediate(r)) // emit #1 at t=100000
  h.advance(500) // < 1000 min-emit window
  h.setWindow({ app: 'B', windowTitle: 'two' })
  await h.poller.tick() // throttled — deferred, NOT recorded as last
  assert.equal(h.emitted.length, 1)
  h.advance(600) // now 1100 since last emit — window passed
  await h.poller.tick() // same "B/two" still current → now emits
  assert.equal(h.emitted.length, 2)
  assert.deepEqual(JSON.parse(h.emitted[1]!.data), { app: 'B', windowTitle: 'two' })
  h.poller.stop()
})

test('an unreadable sample (TCC denied) keeps last state and emits nothing', async () => {
  const h = harness()
  h.setWindow(undefined) // reader returns undefined
  h.poller.setDetectEnabled(true)
  await new Promise((r) => setImmediate(r))
  assert.equal(h.emitted.length, 0)
  assert.equal(h.poller.isActive, true) // still watching — a failed read is not a shutdown
  h.poller.stop()
})

test('flag OFF mid-run stops the loop, clears dedupe, and a later tick is a no-op', async () => {
  const h = harness()
  h.setWindow({ app: 'Code', windowTitle: 'a.ts — repo' })
  h.poller.setDetectEnabled(true)
  await new Promise((r) => setImmediate(r))
  h.poller.setDetectEnabled(false)
  assert.equal(h.poller.isActive, false)
  assert.deepEqual(h.active, [true, false])
  h.advance(5000)
  await h.poller.tick() // inactive → no-op
  assert.equal(h.emitted.length, 1) // only the pre-off emit
})

test('local opt-out (enabled:false) means the flag never activates the loop', async () => {
  const h = harness({ enabled: false })
  h.setWindow({ app: 'Code', windowTitle: 'a.ts — repo' })
  h.poller.setDetectEnabled(true) // engine says on...
  assert.equal(h.poller.isActive, false) // ...but the local opt-out wins — no polling at all
  await h.poller.tick()
  assert.equal(h.emitted.length, 0)
  assert.deepEqual(h.active, []) // never announced active
})

test('re-enabling after an off re-announces the current context (dedupe was cleared)', async () => {
  const h = harness()
  h.setWindow({ app: 'Code', windowTitle: 'a.ts — repo' })
  h.poller.setDetectEnabled(true)
  await new Promise((r) => setImmediate(r)) // emit #1
  h.poller.setDetectEnabled(false)
  h.advance(5000)
  h.poller.setDetectEnabled(true) // back on — same window is "new" again
  await new Promise((r) => setImmediate(r))
  assert.equal(h.emitted.length, 2)
  h.poller.stop()
})
