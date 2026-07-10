import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WindowRegistry } from './app-registry.js'

/** A fake window: an id + a liveness flag, plus counters so we can assert create/focus/close happened. */
interface FakeWindow {
  surfaceId: string
  alive: boolean
  focusCount: number
  closeCount: number
}

/** Build a registry over fake windows, returning it plus the list of created windows for inspection. */
const makeRegistry = () => {
  const created: FakeWindow[] = []
  const registry = new WindowRegistry<FakeWindow>({
    create: (surfaceId) => {
      const w: FakeWindow = { surfaceId, alive: true, focusCount: 0, closeCount: 0 }
      created.push(w)
      return w
    },
    focus: (w) => {
      w.focusCount += 1
    },
    close: (w) => {
      w.closeCount += 1
    },
    isAlive: (w) => w.alive,
  })
  return { registry, created }
}

test('openOrFocus creates a window the first time and FOCUSES (never recreates) on repeat', () => {
  const { registry, created } = makeRegistry()
  const first = registry.openOrFocus('surf-a')
  assert.equal(created.length, 1)
  assert.equal(registry.isOpen('surf-a'), true)

  const again = registry.openOrFocus('surf-a')
  assert.equal(again, first, 'same window returned')
  assert.equal(created.length, 1, 'no second window created')
  assert.equal(first.focusCount, 1, 'the existing window was focused')
})

test('distinct surface ids get distinct windows (a diagnostics app beside the HUD)', () => {
  const { registry, created } = makeRegistry()
  registry.openOrFocus('surf-a')
  registry.openOrFocus('surf-b')
  assert.equal(created.length, 2)
  assert.deepEqual(registry.openSurfaceIds().sort(), ['surf-a', 'surf-b'])
})

test('close asks the window to close but does NOT drop the entry (the shell retires on the closed event)', () => {
  const { registry, created } = makeRegistry()
  registry.openOrFocus('surf-a')
  registry.close('surf-a')
  assert.equal(created[0]?.closeCount, 1)
  // Still registered until retire — matches the electron flow where `closed` fires asynchronously.
  assert.equal(registry.isOpen('surf-a'), true)
  registry.retire('surf-a', created[0])
  assert.equal(registry.isOpen('surf-a'), false)
  assert.deepEqual(registry.openSurfaceIds(), [])
})

test('retire only drops the entry when the stored handle matches (a reopened window is not orphaned)', () => {
  const { registry, created } = makeRegistry()
  const first = registry.openOrFocus('surf-a')
  registry.retire('surf-a', first)
  const second = registry.openOrFocus('surf-a') // reopened — a fresh handle
  // A late `closed` event for the FIRST window must not retire the second.
  registry.retire('surf-a', first)
  assert.equal(registry.isOpen('surf-a'), true)
  assert.equal(registry.windowsList().length, 1)
  assert.equal(registry.windowsList()[0], second)
})

test('a dead handle (destroyed without retire) is treated as closed and replaced', () => {
  const { registry, created } = makeRegistry()
  const first = registry.openOrFocus('surf-a')
  first.alive = false // destroyed out from under us (crash / raced close)
  assert.equal(registry.isOpen('surf-a'), false)
  const replacement = registry.openOrFocus('surf-a')
  assert.notEqual(replacement, first)
  assert.equal(created.length, 2)
  assert.equal(replacement.focusCount, 0, 'a fresh window, not a focus of the dead one')
})

test('closing one window leaves the others untouched (DoD: close one, other unaffected)', () => {
  const { registry, created } = makeRegistry()
  const a = registry.openOrFocus('surf-a')
  const b = registry.openOrFocus('surf-b')
  registry.close('surf-a')
  registry.retire('surf-a', a)
  assert.equal(registry.isOpen('surf-a'), false)
  assert.equal(registry.isOpen('surf-b'), true)
  assert.equal(b.closeCount, 0, 'the other window was never asked to close')
  assert.deepEqual(registry.openSurfaceIds(), ['surf-b'])
})

test('close / retire on an unknown surface id are harmless no-ops', () => {
  const { registry } = makeRegistry()
  registry.close('nope')
  registry.retire('nope')
  assert.deepEqual(registry.openSurfaceIds(), [])
})
