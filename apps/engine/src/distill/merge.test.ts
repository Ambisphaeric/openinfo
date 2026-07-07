import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk } from '@openinfo/contracts'
import { bucketIntoWindows } from './merge.js'

const at = (sec: number, sequence: number): CaptureChunk => ({
  id: `chunk-${sequence}`,
  sessionId: 'ses-1',
  workspaceId: 'ws-1',
  source: 'mic',
  sequence,
  capturedAt: new Date(Date.UTC(2026, 6, 7, 14, 0, sec)).toISOString(),
  contentType: 'text/plain',
  encoding: 'utf8',
  data: `line ${sequence}`,
})

const config = { shortSec: 30, longSec: 120 }

test('a steady stream inside the cap merges into one window', () => {
  const chunks = [at(0, 1), at(10, 2), at(20, 3), at(40, 4)]
  const windows = bucketIntoWindows(chunks, config)
  assert.equal(windows.length, 1)
  assert.equal(windows[0]!.chunks.length, 4)
  assert.equal(windows[0]!.start, chunks[0]!.capturedAt)
  assert.equal(windows[0]!.end, chunks[3]!.capturedAt)
})

test('a gap larger than shortSec closes the window (topic boundary)', () => {
  const windows = bucketIntoWindows([at(0, 1), at(10, 2), at(45, 3)], config) // 35s gap > 30s
  assert.equal(windows.length, 2)
  assert.deepEqual(windows.map((w) => w.chunks.length), [2, 1])
})

test('a continuous stream is capped at longSec (30s→2m rolling merge)', () => {
  // chunks every 20s (gaps < 30s) for 160s → must split once the 120s cap is exceeded
  const chunks = [0, 20, 40, 60, 80, 100, 120, 140].map((s, i) => at(s, i + 1))
  const windows = bucketIntoWindows(chunks, config)
  assert.equal(windows.length, 2)
  // first window covers [0,100] (120 would be >= 120s cap from start), second starts at 120
  assert.equal(windows[0]!.start, chunks[0]!.capturedAt)
  assert.ok(new Date(windows[0]!.end).getTime() - new Date(windows[0]!.start).getTime() < config.longSec * 1000)
  assert.equal(windows[1]!.start, chunks[6]!.capturedAt)
})

test('unsorted input is ordered by capturedAt before bucketing', () => {
  const windows = bucketIntoWindows([at(20, 3), at(0, 1), at(10, 2)], config)
  assert.equal(windows.length, 1)
  assert.deepEqual(windows[0]!.chunks.map((c) => c.sequence), [1, 2, 3])
})

test('empty input yields no windows', () => {
  assert.deepEqual(bucketIntoWindows([], config), [])
})
