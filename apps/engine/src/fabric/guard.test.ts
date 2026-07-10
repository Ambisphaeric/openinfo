import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { GuardSpan } from '@openinfo/contracts'
import { applyRedaction, redactMessages, serializeMessages, evaluateGuard } from './guard.js'

/** ---------- applyRedaction (pure masking) ---------- */

test('applyRedaction masks a single span with [redacted:<kind>] and never leaks the value', () => {
  const text = 'my card is 4111111111111111 ok'
  const spans: GuardSpan[] = [{ start: 11, length: 16, kind: 'card-number' }]
  const out = applyRedaction(text, spans)
  assert.equal(out, 'my card is [redacted:card-number] ok')
  assert.ok(!out.includes('4111111111111111'), 'the raw value never survives redaction')
})

test('applyRedaction masks multiple spans back-to-front so offsets stay valid', () => {
  const text = 'a@b.com calls 555-123-4567'
  const spans: GuardSpan[] = [
    { start: 0, length: 7, kind: 'email' },
    { start: 14, length: 12, kind: 'phone' },
  ]
  assert.equal(applyRedaction(text, spans), '[redacted:email] calls [redacted:phone]')
})

test('applyRedaction clamps an over-long span to the text and skips out-of-range spans', () => {
  const text = 'secret'
  assert.equal(applyRedaction(text, [{ start: 0, length: 999, kind: 'x' }]), '[redacted:x]')
  assert.equal(applyRedaction(text, [{ start: 50, length: 3, kind: 'x' }]), 'secret')
})

/** ---------- redactMessages (offset mapping across the joined serialization) ---------- */

test('serializeMessages joins contents with newlines and redactMessages maps global offsets back per-message', () => {
  const messages = [
    { role: 'system' as const, content: 'be brief' },
    { role: 'user' as const, content: 'ssn 123-45-6789 done' },
  ]
  const joined = serializeMessages(messages)
  const idx = joined.indexOf('123-45-6789')
  const redacted = redactMessages(messages, [{ start: idx, length: 11, kind: 'ssn' }])
  assert.equal(redacted[0]!.content, 'be brief', 'the untouched message is unchanged')
  assert.equal(redacted[1]!.content, 'ssn [redacted:ssn] done')
})

test('redactMessages with no spans returns fresh, equal copies', () => {
  const messages = [{ role: 'user' as const, content: 'nothing here' }]
  const out = redactMessages(messages, [])
  assert.deepEqual(out, messages)
  assert.notEqual(out[0], messages[0], 'a fresh copy, not the same object')
})

/** ---------- evaluateGuard (the whole verdict→behavior decision table) ---------- */

const flagged: GuardSpan[] = [{ start: 0, length: 4, kind: 'card-number' }]

test('guard configured + nothing flagged → proceed, clean', () => {
  const d = evaluateGuard({ spans: [], guardConfigured: true, behavior: 'redact-and-continue', acknowledgeUnguardedEgress: false, guardEndpoint: 'g' })
  assert.equal(d.proceed, true)
  assert.equal(d.redact, false)
  assert.equal(d.verdict.outcome, 'clean')
  assert.equal(d.verdict.guarded, true)
  assert.equal(d.verdict.maskedSpanCount, 0)
})

test('guard configured + flagged + redact-and-continue → proceed + redact, spans recorded (never raw)', () => {
  const d = evaluateGuard({ spans: flagged, guardConfigured: true, behavior: 'redact-and-continue', acknowledgeUnguardedEgress: false, guardEndpoint: 'g' })
  assert.equal(d.proceed, true)
  assert.equal(d.redact, true)
  assert.equal(d.verdict.outcome, 'redacted')
  assert.equal(d.verdict.maskedSpanCount, 1)
  assert.deepEqual(d.verdict.spans, flagged)
})

test('guard configured + flagged + hold-and-surface (strict) → HOLD', () => {
  const d = evaluateGuard({ spans: flagged, guardConfigured: true, behavior: 'hold-and-surface', acknowledgeUnguardedEgress: false, guardEndpoint: 'g' })
  assert.equal(d.proceed, false)
  assert.equal(d.verdict.outcome, 'held')
  assert.equal(d.verdict.maskedSpanCount, 1)
  assert.deepEqual(d.verdict.spans, flagged)
})

test('EMPTY guard slot + hold-and-surface (strict) → HOLD (fail closed)', () => {
  const d = evaluateGuard({ spans: [], guardConfigured: false, behavior: 'hold-and-surface', acknowledgeUnguardedEgress: false })
  assert.equal(d.proceed, false)
  assert.equal(d.verdict.outcome, 'held')
  assert.equal(d.verdict.guarded, false)
})

test('EMPTY guard slot + default + acknowledged → proceed UNGUARDED (recorded)', () => {
  const d = evaluateGuard({ spans: [], guardConfigured: false, behavior: 'redact-and-continue', acknowledgeUnguardedEgress: true })
  assert.equal(d.proceed, true)
  assert.equal(d.redact, false)
  assert.equal(d.verdict.outcome, 'unguarded')
  assert.equal(d.verdict.guarded, false)
})

test('EMPTY guard slot + default + NOT acknowledged → HOLD (never silently unguarded)', () => {
  const d = evaluateGuard({ spans: [], guardConfigured: false, behavior: 'redact-and-continue', acknowledgeUnguardedEgress: false })
  assert.equal(d.proceed, false)
  assert.equal(d.verdict.outcome, 'held')
  assert.equal(d.verdict.guarded, false)
})
