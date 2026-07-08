import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectEta } from './eta.js'

const NOW = Date.parse('2026-07-08T18:00:00Z')

test('projectEta: no samples → basis none, no fabricated ETA', () => {
  const eta = projectEta({ backlogChunks: 10, samples: [], now: NOW })
  assert.equal(eta.basis, 'none')
  assert.equal(eta.etaMs, undefined)
  assert.equal(eta.caughtUpBy, undefined)
})

test('projectEta: empty backlog → already caught up (etaMs 0, now)', () => {
  const eta = projectEta({ backlogChunks: 0, samples: [{ chunks: 4, ms: 1000 }], now: NOW })
  assert.equal(eta.basis, 'observed')
  assert.equal(eta.etaMs, 0)
  assert.equal(eta.caughtUpBy, new Date(NOW).toISOString())
})

test('projectEta: observed rate projects etaMs and caughtUpBy', () => {
  // 10 chunks drained in 5000ms across two files → 2 chunks/sec; backlog 20 → 10_000ms
  const eta = projectEta({
    backlogChunks: 20,
    samples: [{ chunks: 4, ms: 2000 }, { chunks: 6, ms: 3000 }],
    now: NOW,
  })
  assert.equal(eta.basis, 'observed')
  assert.equal(eta.etaMs, 10000)
  assert.equal(eta.drainRateChunksPerSec, 2)
  assert.equal(eta.caughtUpBy, new Date(NOW + 10000).toISOString())
})

test('projectEta: zero-chunk or zero-time samples → basis none (no divide-by-zero fabrication)', () => {
  assert.equal(projectEta({ backlogChunks: 5, samples: [{ chunks: 0, ms: 1000 }], now: NOW }).basis, 'none')
  assert.equal(projectEta({ backlogChunks: 5, samples: [{ chunks: 3, ms: 0 }], now: NOW }).basis, 'none')
})

test('projectEta: measuredTokPerSec is echoed as context in both basis states', () => {
  const none = projectEta({ backlogChunks: 5, samples: [], now: NOW, measuredTokPerSec: 41 })
  assert.equal(none.basis, 'none')
  assert.equal(none.measuredTokPerSec, 41)
  const observed = projectEta({ backlogChunks: 4, samples: [{ chunks: 2, ms: 1000 }], now: NOW, measuredTokPerSec: 88 })
  assert.equal(observed.basis, 'observed')
  assert.equal(observed.measuredTokPerSec, 88)
})
