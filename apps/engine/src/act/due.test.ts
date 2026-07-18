import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveDue } from './due.js'

// A fixed extraction wall-clock so every assertion is deterministic.
const anchor = new Date('2026-07-16T15:00:00.000Z')

test('model proposal: a parseable, in-horizon ISO is accepted verbatim and marked model-sourced', () => {
  const r = resolveDue({ modelDue: '2026-07-16T15:18:00.000Z', text: 'Give QA feedback', anchor })
  assert.equal(r.due, '2026-07-16T15:18:00.000Z')
  assert.equal(r.dueSource, 'model')
})

test('model proposal: garbage ISO is DROPPED (no due), the item survives without a fabricated deadline', () => {
  const r = resolveDue({ modelDue: 'sometime next week', text: 'Give QA feedback', anchor })
  assert.equal(r.due, undefined)
  assert.equal(r.dueSource, undefined)
})

test('model proposal: a time in the PAST beyond the slack is dropped', () => {
  const r = resolveDue({ modelDue: '2026-07-16T13:00:00.000Z', text: 'Give QA feedback', anchor })
  assert.equal(r.due, undefined)
})

test('model proposal: a time FAR in the future (> 60 days) is dropped as an implausible mis-parse', () => {
  const r = resolveDue({ modelDue: '2026-12-31T00:00:00.000Z', text: 'Give QA feedback', anchor })
  assert.equal(r.due, undefined)
})

test('model proposal: a within-slack near-past time (clock skew) is kept', () => {
  const r = resolveDue({ modelDue: '2026-07-16T14:59:30.000Z', text: 'x', anchor })
  assert.equal(r.dueSource, 'model')
})

test('deterministic fallback: the flagship spoken form "in eighteen minutes" anchors to windowEnd', () => {
  const r = resolveDue({ modelDue: undefined, text: 'Provide feedback to QA in eighteen minutes', anchor })
  assert.equal(r.due, '2026-07-16T15:18:00.000Z')
  assert.equal(r.dueSource, 'anchored')
})

test('deterministic fallback: digits work too — "in 2 hours"', () => {
  const r = resolveDue({ modelDue: undefined, text: 'Ship the patch in 2 hours', anchor })
  assert.equal(r.due, '2026-07-16T17:00:00.000Z')
  assert.equal(r.dueSource, 'anchored')
})

test('deterministic fallback: compound number words — "in forty-five minutes"', () => {
  const r = resolveDue({ modelDue: undefined, text: 'Call back in forty-five minutes', anchor })
  assert.equal(r.due, '2026-07-16T15:45:00.000Z')
})

test('deterministic fallback: "in 3 days"', () => {
  const r = resolveDue({ modelDue: undefined, text: 'Follow up in 3 days', anchor })
  assert.equal(r.due, '2026-07-19T15:00:00.000Z')
})

test('deterministic fallback: an out-of-horizon relative time ("in 90 days") is dropped', () => {
  const r = resolveDue({ modelDue: undefined, text: 'Renew in 90 days', anchor })
  assert.equal(r.due, undefined)
})

test('no deadline anywhere ⇒ no due (nothing invented)', () => {
  const r = resolveDue({ modelDue: undefined, text: 'Send Dana the deck', anchor })
  assert.deepEqual(r, {})
})

test('a valid model ISO wins even when the text also carries a relative phrase', () => {
  const r = resolveDue({ modelDue: '2026-07-16T16:00:00.000Z', text: 'do it in 5 minutes', anchor })
  assert.equal(r.due, '2026-07-16T16:00:00.000Z')
  assert.equal(r.dueSource, 'model')
})
