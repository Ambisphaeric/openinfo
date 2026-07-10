import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  asChunkStrategy,
  DEFAULT_CHUNK_STRATEGY,
  DEFAULT_VAD_PARAMS,
  nextSilenceRunMs,
  resolveVadParams,
  shouldRotate,
  type VadParams,
} from './vad.js'

/**
 * The #95 pause-based rotation decision, proven pure (the renderer's browser plumbing feeds it telemetry).
 * These lock the accuracy↔latency behaviour the measurements chose: cut at a real pause once past the
 * minimum, never mid-word, and always cut by the max cap so pauseless speech still bounds latency.
 */

test('the measured default strategy is vad (cut at pauses, not the wall clock)', () => {
  assert.equal(DEFAULT_CHUNK_STRATEGY, 'vad')
})

test('nextSilenceRunMs extends the quiet run and resets the instant speech returns', () => {
  const floor = DEFAULT_VAD_PARAMS.silencePeak
  // three quiet ticks accumulate
  let run = 0
  run = nextSilenceRunMs(run, 50, 0.001, floor)
  run = nextSilenceRunMs(run, 50, 0.005, floor)
  run = nextSilenceRunMs(run, 50, 0.0, floor)
  assert.equal(run, 150)
  // a loud tick (peak at/above the floor) resets it to zero
  assert.equal(nextSilenceRunMs(run, 50, 0.3, floor), 0)
  assert.equal(nextSilenceRunMs(run, 50, floor, floor), 0, 'peak exactly at the floor counts as speech')
})

test('shouldRotate cuts at a pause only after the minimum segment length', () => {
  const p: VadParams = resolveVadParams({ minSegmentMs: 600, silenceHoldMs: 400, maxSegmentMs: 6000 })
  // long enough pause but not enough audio yet ⇒ hold (don't ship a fragment)
  assert.equal(shouldRotate(500, 500, p), false)
  // past the minimum AND quiet long enough ⇒ cut (the cut lands in the pause)
  assert.equal(shouldRotate(700, 400, p), true)
  // past the minimum but the pause is too short ⇒ hold (mid-word gaps don't trigger)
  assert.equal(shouldRotate(700, 150, p), false)
})

test('shouldRotate always cuts by the max cap even with no pause (pauseless-speech latency bound)', () => {
  const p = resolveVadParams({ minSegmentMs: 600, silenceHoldMs: 400, maxSegmentMs: 6000 })
  assert.equal(shouldRotate(6000, 0, p), true)
  assert.equal(shouldRotate(6001, 0, p), true)
  assert.equal(shouldRotate(5999, 0, p), false, 'just under the cap with no pause ⇒ keep recording')
})

test('resolveVadParams falls back per-field on absent/garbage and keeps max ≥ min', () => {
  assert.deepEqual(resolveVadParams(), DEFAULT_VAD_PARAMS)
  assert.deepEqual(resolveVadParams({}), DEFAULT_VAD_PARAMS)
  const bad = resolveVadParams({
    silenceHoldMs: -5,
    minSegmentMs: Number.NaN,
    maxSegmentMs: 0,
    silencePeak: -1,
  })
  assert.deepEqual(bad, DEFAULT_VAD_PARAMS, 'every garbage field falls back to its default')
  // a max below the min is raised to the min so the cap never undercuts the floor
  const clamped = resolveVadParams({ minSegmentMs: 2000, maxSegmentMs: 1000 })
  assert.equal(clamped.maxSegmentMs, 2000)
})

test('asChunkStrategy accepts only known strategies', () => {
  assert.equal(asChunkStrategy('vad'), 'vad')
  assert.equal(asChunkStrategy('fixed'), 'fixed')
  assert.equal(asChunkStrategy('overlap'), undefined)
  assert.equal(asChunkStrategy(undefined), undefined)
  assert.equal(asChunkStrategy(5), undefined)
})
