import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EchoDedupe } from './echo-dedupe.js'
import { ECHO_BLEED_FIXTURES } from './echo-bleed-fixtures.js'

/**
 * Drives the whole echo-bleed tuning corpus (echo-bleed-fixtures.ts) through EchoDedupe: prime the buffer
 * with the far-side system line, then check the mic fragment `deltaMs` later. Each case asserts its
 * labelled verdict — the GARBLED-twin positives (the #151 miss) drop, the genuine-dialogue negatives are
 * kept. The negatives are the load-bearing half: a regression that starts eating real speech fails here.
 */
const base = Date.UTC(2026, 6, 17, 9, 0, 0)
const iso = (offsetMs: number): string => new Date(base + offsetMs).toISOString()

for (const fixture of ECHO_BLEED_FIXTURES) {
  test(`echo-bleed corpus: ${fixture.name} ⇒ ${fixture.expectEcho ? 'dropped (bleed)' : 'kept (genuine)'}`, () => {
    const dedupe = new EchoDedupe()
    dedupe.observeSystem({ sessionId: 'ses-bleed', text: fixture.system, capturedAt: iso(0) })
    const verdict = dedupe.isEcho({ sessionId: 'ses-bleed', text: fixture.mic, capturedAt: iso(fixture.deltaMs) })
    assert.equal(verdict, fixture.expectEcho, `${fixture.name}: ${fixture.note}`)
  })
}

test('echo-bleed corpus: models both regimes (garbled-twin positives AND genuine-speech negatives)', () => {
  const positives = ECHO_BLEED_FIXTURES.filter((f) => f.expectEcho).length
  const negatives = ECHO_BLEED_FIXTURES.filter((f) => !f.expectEcho).length
  // The corpus is worthless as a false-positive guard without genuine-speech negatives, and worthless as
  // a catch-rate guard without garbled positives — assert both halves exist so neither can silently drain.
  assert.ok(positives >= 3, 'corpus carries garbled-twin positives')
  assert.ok(negatives >= 4, 'corpus carries genuine-speech negatives (the false-positive floor)')
})
