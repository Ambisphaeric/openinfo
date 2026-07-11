import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeDeltaScore,
  shouldSend,
  FrameDeltaGate,
  DELTA_THRESHOLD_DEFAULT,
  DELTA_HEARTBEAT_TICKS,
} from './frame-delta.js'

// Probes sized so stride-4 sampling lands on indices 0,4,8,... — `fill` targets sampled bytes directly.
const probe = (len: number, fill: Record<number, number> = {}): Uint8Array => {
  const out = new Uint8Array(len)
  for (const [i, v] of Object.entries(fill)) out[Number(i)] = v
  return out
}

test('computeDeltaScore: identical buffers score 0', () => {
  assert.equal(computeDeltaScore(probe(40), probe(40)), 0)
})

test('computeDeltaScore: fully-different buffers score 1', () => {
  assert.equal(computeDeltaScore(probe(40), new Uint8Array(40).fill(200)), 1)
})

test('computeDeltaScore: per-byte tolerance 8 — |a−b| must EXCEED it to count', () => {
  // len 8 samples indices 0 and 4 (2 samples). A diff of exactly 8 is inside tolerance; 9 is change.
  assert.equal(computeDeltaScore(probe(8), probe(8, { 0: 8 })), 0)
  assert.equal(computeDeltaScore(probe(8), probe(8, { 0: 9 })), 0.5)
})

test('computeDeltaScore: length mismatch and empty probes fail open to 1', () => {
  assert.equal(computeDeltaScore(probe(40), probe(44)), 1) // resolution changed between ticks
  assert.equal(computeDeltaScore(probe(0), probe(0)), 1) // nothing to compare — let the frame through
})

test('computeDeltaScore: stride sampling still sees a large change', () => {
  // Half the buffer rewritten (first 20 of 40 bytes) — sampled indices 0,4,8,12,16 of 10 → 0.5.
  const changed = new Uint8Array(40)
  changed.fill(200, 0, 20)
  assert.equal(computeDeltaScore(probe(40), changed), 0.5)
})

test('shouldSend: below threshold with no heartbeat due is a skip', () => {
  assert.equal(shouldSend(DELTA_THRESHOLD_DEFAULT / 2, 1), false)
})

test('shouldSend: at/above threshold sends', () => {
  assert.equal(shouldSend(DELTA_THRESHOLD_DEFAULT, 1), true)
  assert.equal(shouldSend(0.9, 1), true)
})

test('shouldSend: the heartbeat tick sends even a zero-change frame', () => {
  assert.equal(shouldSend(0, DELTA_HEARTBEAT_TICKS - 1), false)
  assert.equal(shouldSend(0, DELTA_HEARTBEAT_TICKS), true)
})

test('FrameDeltaGate: the first frame of a display always sends (score 1)', () => {
  const verdict = new FrameDeltaGate().assess('d1', probe(40))
  assert.deepEqual(verdict, { send: true, deltaScore: 1, skipStreak: 0 })
})

test('FrameDeltaGate: a static frame skips, with the streak counting up', () => {
  const gate = new FrameDeltaGate(0.5, 100) // heartbeat far away — isolate the threshold behaviour
  gate.assess('d1', probe(40))
  assert.deepEqual(gate.assess('d1', probe(40)), { send: false, deltaScore: 0, skipStreak: 1 })
  assert.deepEqual(gate.assess('d1', probe(40)), { send: false, deltaScore: 0, skipStreak: 2 })
})

test('FrameDeltaGate: gradual drift accumulates against the last KEPT probe until it crosses', () => {
  const gate = new FrameDeltaGate(0.5, 100)
  gate.assess('d1', probe(40)) // kept baseline: all zeros (10 sampled bytes)
  // Each step changes only 0.2 vs the PREVIOUS frame — under a last-seen comparison nothing would ever
  // send; against the last-kept baseline the score climbs 0.2 → 0.4 → 0.6 and the third step crosses.
  assert.equal(gate.assess('d1', probe(40, { 0: 200, 4: 200 })).send, false) // 2/10
  assert.equal(gate.assess('d1', probe(40, { 0: 200, 4: 200, 8: 200, 12: 200 })).send, false) // 4/10
  const crossed = gate.assess('d1', probe(40, { 0: 200, 4: 200, 8: 200, 12: 200, 16: 200, 20: 200 }))
  assert.deepEqual(crossed, { send: true, deltaScore: 0.6, skipStreak: 0 })
})

test('FrameDeltaGate: displays are isolated — a new displayId is a first frame', () => {
  const gate = new FrameDeltaGate(0.5, 100)
  gate.assess('d1', probe(40))
  assert.equal(gate.assess('d2', probe(40)).send, true) // d1's state never gates d2
  assert.equal(gate.assess('d1', probe(40)).send, false) // while d1 itself is still static
})

test('FrameDeltaGate: reset() forgets state so the next frame always sends', () => {
  const gate = new FrameDeltaGate(0.5, 100)
  gate.assess('d1', probe(40))
  gate.reset()
  assert.deepEqual(gate.assess('d1', probe(40)), { send: true, deltaScore: 1, skipStreak: 0 })
})
