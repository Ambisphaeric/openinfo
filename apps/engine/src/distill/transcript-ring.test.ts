import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TranscriptUpdate } from '@openinfo/contracts'
import { TranscriptRing } from './transcript-ring.js'

const update = (sessionId: string, text: string): TranscriptUpdate => ({
  sessionId,
  source: 'mic',
  text,
  capturedAtRange: { start: '2026-07-12T12:00:00Z', end: '2026-07-12T12:00:01Z' },
})

test('recentForSessions returns only updates from the supplied workspace session set', () => {
  const ring = new TranscriptRing()
  ring.record(update('ses-a', 'workspace A private words'))
  ring.record(update('ses-b', 'workspace B private words'))
  ring.record(update('ses-a', 'workspace A newest words'))

  assert.deepEqual(
    ring.recentForSessions(new Set(['ses-a'])).map((item) => item.text),
    ['workspace A newest words', 'workspace A private words'],
  )
  assert.deepEqual(ring.recentForSessions(new Set()).map((item) => item.text), [])
  assert.deepEqual(ring.recent().map((item) => item.text), [
    'workspace A newest words',
    'workspace B private words',
    'workspace A private words',
  ], 'the process-wide diagnostics view remains intact')
})
