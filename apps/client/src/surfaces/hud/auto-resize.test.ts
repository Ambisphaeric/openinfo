import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installAutoResize, STAGE_VERTICAL_PADDING, type ResizeBridge } from './auto-resize.js'

/** A fake element whose height the test drives. */
const fakeEl = (height: number) => {
  const el = { height, getBoundingClientRect: () => ({ height: el.height }) }
  return el
}

/** A bridge that records every reported height. */
const spyBridge = (): ResizeBridge & { reports: number[] } => {
  const b = { reports: [] as number[], resize: (h: number) => b.reports.push(h) }
  return b
}

/**
 * A fake window whose ResizeObserver hands its callback back to the test to fire, and whose rAF runs
 * synchronously so a scheduled report resolves in-line.
 */
const fakeWin = () => {
  let observerCb: (() => void) | undefined
  return {
    win: {
      ResizeObserver: class {
        constructor(cb: () => void) {
          observerCb = cb
        }
        observe() {}
        disconnect() {
          observerCb = undefined
        }
      },
      requestAnimationFrame: (cb: () => void) => {
        cb()
        return 0
      },
    },
    fireResize: () => observerCb?.(),
    get disconnected() {
      return observerCb === undefined
    },
  }
}

test('reports the initial height immediately (panel height + stage padding)', () => {
  const el = fakeEl(200)
  const bridge = spyBridge()
  const { win } = fakeWin()
  installAutoResize(el, bridge, win)
  assert.deepEqual(bridge.reports, [200 + STAGE_VERTICAL_PADDING])
})

test('a fractional panel height is ceiled', () => {
  const el = fakeEl(199.1)
  const bridge = spyBridge()
  const { win } = fakeWin()
  installAutoResize(el, bridge, win)
  assert.deepEqual(bridge.reports, [200 + STAGE_VERTICAL_PADDING])
})

test('an observed change to a NEW height is reported; an unchanged height is deduped', () => {
  const el = fakeEl(200)
  const bridge = spyBridge()
  const { win, fireResize } = fakeWin()
  installAutoResize(el, bridge, win)
  assert.deepEqual(bridge.reports, [224]) // initial

  fireResize() // same height — no new report
  assert.deepEqual(bridge.reports, [224])

  el.height = 360
  fireResize() // grew — reported once
  assert.deepEqual(bridge.reports, [224, 384])

  el.height = 120
  fireResize() // shrank — reported once
  assert.deepEqual(bridge.reports, [224, 384, 144])

  fireResize() // unchanged again — deduped
  assert.deepEqual(bridge.reports, [224, 384, 144])
})

test('the disposer disconnects the observer', () => {
  const el = fakeEl(200)
  const bridge = spyBridge()
  const fake = fakeWin()
  const dispose = installAutoResize(el, bridge, fake.win)
  assert.equal(fake.disconnected, false)
  dispose()
  assert.equal(fake.disconnected, true)
})
