import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installWindowDrag, isGrabTarget, type DragBridge } from './window-drag.js'

interface HitLike {
  closest(selector: string): unknown
}
interface DragEventLike {
  target: HitLike | null
  button?: number
}

/**
 * A fake event target whose `closest` matches a fixed set of selectors this node "is inside" — like the
 * real DOM `closest`, a comma-separated selector list matches if ANY of its selectors does.
 */
const target = (...inside: string[]): HitLike => ({
  closest: (selector: string) =>
    selector.split(',').some((s) => inside.includes(s.trim())) ? {} : null,
})

test('the header strip is a grab target', () => {
  assert.equal(isGrabTarget(target('.hudtop')), true)
})

test('an action button inside the strip is NOT a grab target (clicks survive)', () => {
  assert.equal(isGrabTarget(target('.hudtop', '[data-verb]')), false)
  assert.equal(isGrabTarget(target('.hudtop', '.mini')), false)
})

test('something outside the strip is not a grab target', () => {
  assert.equal(isGrabTarget(target('.stream')), false)
  assert.equal(isGrabTarget(null), false)
})

/** A fake document that records handlers so the test can fire synthetic events at them. */
const fakeDoc = () => {
  const handlers: Record<string, ((event: DragEventLike) => void)[]> = {}
  return {
    doc: {
      addEventListener: (type: string, handler: (event: DragEventLike) => void) => {
        ;(handlers[type] ??= []).push(handler)
      },
    },
    fire: (type: string, event: DragEventLike) => (handlers[type] ?? []).forEach((h) => h(event)),
  }
}

const spyBridge = (): DragBridge & { starts: number; ends: number } => {
  const b = { starts: 0, ends: 0, start: () => (b.starts += 1), end: () => (b.ends += 1) }
  return b
}

test('mousedown on the strip starts a drag; mouseup ends it', () => {
  const { doc, fire } = fakeDoc()
  const bridge = spyBridge()
  installWindowDrag(doc, bridge)
  fire('mousedown', { target: target('.hudtop'), button: 0 })
  assert.equal(bridge.starts, 1)
  fire('mouseup', { target: target('.hudtop') })
  assert.equal(bridge.ends, 1)
})

test('mousedown on an action button does not start a drag', () => {
  const { doc, fire } = fakeDoc()
  const bridge = spyBridge()
  installWindowDrag(doc, bridge)
  fire('mousedown', { target: target('.hudtop', '.mini'), button: 0 })
  assert.equal(bridge.starts, 0)
})

test('a non-primary (e.g. right) button does not start a drag', () => {
  const { doc, fire } = fakeDoc()
  const bridge = spyBridge()
  installWindowDrag(doc, bridge)
  fire('mousedown', { target: target('.hudtop'), button: 2 })
  assert.equal(bridge.starts, 0)
})

test('the pointer leaving the window ends any drag', () => {
  const { doc, fire } = fakeDoc()
  const bridge = spyBridge()
  installWindowDrag(doc, bridge)
  fire('mouseleave', { target: target('.stage') })
  assert.equal(bridge.ends, 1)
})
