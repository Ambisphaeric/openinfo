import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  grabOffset,
  draggedOrigin,
  serializeWindowState,
  parseWindowState,
  isPositionUsable,
  resolveStartupPosition,
  type DisplayArea,
} from './window-position.js'

const SIZE = { width: 708, height: 720 }
const PRIMARY: DisplayArea = { x: 0, y: 0, width: 1440, height: 900 }

test('grab offset then dragged origin keeps the grabbed point under the cursor', () => {
  const origin = { x: 100, y: 200 }
  const grab = { x: 130, y: 210 } // 30px right, 10px down inside the window
  const offset = grabOffset(grab, origin)
  assert.deepEqual(offset, { x: 30, y: 10 })
  // cursor moves to (400, 500): the window origin follows so the offset is preserved
  assert.deepEqual(draggedOrigin({ x: 400, y: 500 }, offset), { x: 370, y: 490 })
})

test('dragged origin is rounded to whole pixels', () => {
  assert.deepEqual(draggedOrigin({ x: 10.6, y: 20.4 }, { x: 0, y: 0 }), { x: 11, y: 20 })
})

test('serialize / parse round-trips the origin', () => {
  const pos = { x: 321, y: 88 }
  assert.deepEqual(parseWindowState(serializeWindowState(pos)), pos)
})

test('serialize rounds sub-pixel origins', () => {
  assert.equal(serializeWindowState({ x: 12.7, y: 40.2 }), '{"x":13,"y":40}')
})

test('parse rejects garbage, wrong shapes, and non-finite numbers → undefined', () => {
  assert.equal(parseWindowState(''), undefined)
  assert.equal(parseWindowState('not json'), undefined)
  assert.equal(parseWindowState('null'), undefined)
  assert.equal(parseWindowState('[1,2]'), undefined)
  assert.equal(parseWindowState('{"x":1}'), undefined)
  assert.equal(parseWindowState('{"x":"1","y":"2"}'), undefined)
  assert.equal(parseWindowState('{"x":null,"y":0}'), undefined)
})

test('a position well inside the primary display is usable', () => {
  assert.equal(isPositionUsable({ x: 300, y: 120 }, SIZE, [PRIMARY]), true)
})

test('a position on an unplugged monitor is not usable (falls back to centering)', () => {
  // origin far to the right, as if a second monitor at x=1440 is now gone
  assert.equal(isPositionUsable({ x: 2000, y: 300 }, SIZE, [PRIMARY]), false)
})

test('a position mostly off the top (grab strip above the work area) is not usable', () => {
  assert.equal(isPositionUsable({ x: 300, y: -400 }, SIZE, [PRIMARY]), false)
})

test('a sliver still on-screen but below the min-visible threshold is not usable', () => {
  // only ~20px of the window pokes onto the display from the right edge
  assert.equal(isPositionUsable({ x: PRIMARY.width - 20, y: 100 }, SIZE, [PRIMARY]), false)
})

test('a spot valid on a secondary display is usable when that display is present', () => {
  const secondary: DisplayArea = { x: 1440, y: 0, width: 1920, height: 1080 }
  assert.equal(isPositionUsable({ x: 1600, y: 200 }, SIZE, [PRIMARY, secondary]), true)
})

test('resolveStartupPosition returns the saved spot when usable, undefined when not', () => {
  assert.deepEqual(resolveStartupPosition({ x: 300, y: 120 }, SIZE, [PRIMARY]), { x: 300, y: 120 })
  assert.equal(resolveStartupPosition({ x: 5000, y: 5000 }, SIZE, [PRIMARY]), undefined)
  assert.equal(resolveStartupPosition(undefined, SIZE, [PRIMARY]), undefined)
})
