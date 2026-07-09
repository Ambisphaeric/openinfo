import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveHudHeight } from './hud-height.js'

test('a fractional measurement is ceiled (never clip the last row)', () => {
  assert.equal(resolveHudHeight(180.2, { min: 96 }), 181)
  assert.equal(resolveHudHeight(180.0, { min: 96 }), 180)
})

test('a measurement below the floor is clamped up to min', () => {
  assert.equal(resolveHudHeight(40, { min: 96 }), 96)
  assert.equal(resolveHudHeight(0, { min: 96 }), 96)
})

test('a non-finite measurement falls back to the floor (never resize to garbage)', () => {
  assert.equal(resolveHudHeight(Number.NaN, { min: 96 }), 96)
  assert.equal(resolveHudHeight(Number.POSITIVE_INFINITY, { min: 96 }), 96)
  assert.equal(resolveHudHeight(Number.NEGATIVE_INFINITY, { min: 96 }), 96)
})

test('a measurement above max is capped at the work-area height', () => {
  assert.equal(resolveHudHeight(2000, { min: 96, max: 900 }), 900)
})

test('without a max, a tall measurement passes through (ceiled)', () => {
  assert.equal(resolveHudHeight(1234.1, { min: 96 }), 1235)
})

test('an in-range measurement passes through unchanged', () => {
  assert.equal(resolveHudHeight(420, { min: 96, max: 900 }), 420)
})
