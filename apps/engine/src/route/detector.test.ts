import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FocusSignal, WorkspaceHints } from '@openinfo/contracts'
import { DEFAULT_DETECTOR_CONFIG, detectSwitch, type TimedFocusSignal } from './detector.js'

const at = (sec: number): string => new Date(Date.UTC(2026, 6, 7, 14, 0, 0) + sec * 1000).toISOString()

const eng: FocusSignal = { app: 'Code', windowTitle: 'detector.ts — openinfo', repoPath: '/Users/dev/openinfo' }
const sales: FocusSignal = { app: 'Chrome', windowTitle: 'Acme — Salesforce', repoPath: '/Users/dev/acme-crm' }
const idle: FocusSignal = { app: 'Finder', windowTitle: 'Downloads' }

const hints: WorkspaceHints[] = [
  { workspaceId: 'eng', patterns: [{ field: 'repoPath', contains: 'openinfo', weight: 0.6 }] },
  {
    workspaceId: 'sales',
    patterns: [
      { field: 'repoPath', contains: 'acme-crm', weight: 0.7 },
      { field: 'windowTitle', contains: 'Salesforce', weight: 0.5 },
    ],
  },
]

/** `count` copies of `signal` spaced `step` seconds apart, starting at `startSec`. */
const streamOf = (signal: FocusSignal, count: number, startSec = 0, step = 10): TimedFocusSignal[] =>
  Array.from({ length: count }, (_, i) => ({ at: at(startSec + i * step), signal }))

/** Interleave two signals evenly across `count` samples (a/b/a/b…), spanning >sustain. */
const alternating = (a: FocusSignal, b: FocusSignal, count: number, step = 10): TimedFocusSignal[] =>
  Array.from({ length: count }, (_, i) => ({ at: at(i * step), signal: i % 2 === 0 ? a : b }))

test('sustained dominance fires a switch with capped confidence and matched evidence', () => {
  const result = detectSwitch(streamOf(eng, 11), hints, undefined)
  assert.equal(result.decision, 'switch')
  assert.equal(result.toWorkspaceId, 'eng')
  assert.equal(result.confidence, DEFAULT_DETECTOR_CONFIG.maxConfidence) // share 1.0 capped to 0.9
  assert.ok(result.confidence < 1)
  assert.deepEqual(result.evidence, [{ kind: 'repo', detail: 'repoPath contains "openinfo"', weight: 0.6 }])
})

test('a brief minority alt-tab does not stop a genuine dominant switch', () => {
  // 9 eng + 2 sales interleaved: eng share ~0.82 ≥ 0.6 → still switches to eng.
  const signals = streamOf(eng, 11)
  signals[3] = { at: at(30), signal: sales }
  signals[7] = { at: at(70), signal: sales }
  const result = detectSwitch(signals, hints, undefined)
  assert.equal(result.decision, 'switch')
  assert.equal(result.toWorkspaceId, 'eng')
})

test('an even split between two workspaces is ambiguous → stay (thrash resistance)', () => {
  const result = detectSwitch(alternating(eng, sales, 11), hints, undefined)
  assert.equal(result.decision, 'stay')
  assert.deepEqual(result.evidence, [])
})

test('signals matching no hints → stay, no evidence', () => {
  const result = detectSwitch(streamOf(idle, 11), hints, undefined)
  assert.equal(result.decision, 'stay')
  assert.deepEqual(result.evidence, [])
})

test('less than a full sustain window of observation → stay', () => {
  // 8 signals at 10s step span only 70s (< 90s sustain) — not enough to commit.
  const result = detectSwitch(streamOf(eng, 8), hints, undefined)
  assert.equal(result.decision, 'stay')
})

test('sustained dominance for a DIFFERENT workspace than the live one → switch away', () => {
  const result = detectSwitch(streamOf(sales, 11), hints, 'eng')
  assert.equal(result.decision, 'switch')
  assert.equal(result.toWorkspaceId, 'sales')
  // sales matches BOTH its patterns per signal → both evidence entries, deduped.
  assert.deepEqual(
    result.evidence.map((e) => e.detail).sort(),
    ['repoPath contains "acme-crm"', 'windowTitle contains "Salesforce"'],
  )
})

test('the dominant workspace being the CURRENT one → stay (no re-fire / no thrash)', () => {
  const result = detectSwitch(streamOf(eng, 11), hints, 'eng')
  assert.equal(result.decision, 'stay')
})

test('empty signal stream → stay', () => {
  assert.equal(detectSwitch([], hints, undefined).decision, 'stay')
})
