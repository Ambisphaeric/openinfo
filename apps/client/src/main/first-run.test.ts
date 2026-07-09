import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { shouldOpenSetup, shouldPromptMic, parseFirstRunState } from './first-run.js'
import { readFirstRunState, markFirstRunShown, markMicPrompted, firstRunStatePath } from './first-run-store.js'

test('shouldOpenSetup: reachable + empty llm slot + not yet shown ⇒ open once', () => {
  assert.equal(shouldOpenSetup({ engineReachable: true, needsModelSetup: true, alreadyShown: false }), true)
})

test('shouldOpenSetup: suppressed when already shown, when a model exists, when unreachable, or when unknown', () => {
  assert.equal(shouldOpenSetup({ engineReachable: true, needsModelSetup: true, alreadyShown: true }), false) // never nag twice
  assert.equal(shouldOpenSetup({ engineReachable: true, needsModelSetup: false, alreadyShown: false }), false) // model already set up
  assert.equal(shouldOpenSetup({ engineReachable: false, needsModelSetup: true, alreadyShown: false }), false) // no engine ⇒ no /setup
  assert.equal(shouldOpenSetup({ engineReachable: true, needsModelSetup: undefined, alreadyShown: false }), false) // don't nag before we know
})

test('shouldPromptMic: ask once at first launch, then never again', () => {
  assert.equal(shouldPromptMic({ alreadyPrompted: false }), true) // first launch ⇒ fire the mic popup
  assert.equal(shouldPromptMic({ alreadyPrompted: true }), false) // once-only — never re-nag
})

test('parseFirstRunState reads both markers and ignores junk', () => {
  assert.deepEqual(parseFirstRunState({ firstRunShownAt: '2026-07-08T00:00:00.000Z' }), { firstRunShownAt: '2026-07-08T00:00:00.000Z' })
  assert.deepEqual(parseFirstRunState({ micPromptedAt: '2026-07-08T00:00:00.000Z' }), { micPromptedAt: '2026-07-08T00:00:00.000Z' })
  assert.deepEqual(
    parseFirstRunState({ firstRunShownAt: '2026-07-08T00:00:00.000Z', micPromptedAt: '2026-07-08T01:00:00.000Z' }),
    { firstRunShownAt: '2026-07-08T00:00:00.000Z', micPromptedAt: '2026-07-08T01:00:00.000Z' },
  )
  assert.deepEqual(parseFirstRunState({ firstRunShownAt: 123 }), {})
  assert.deepEqual(parseFirstRunState(null), {})
  assert.deepEqual(parseFirstRunState('nope'), {})
})

test('first-run store round-trips and never-shown reads as empty', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'openinfo-first-run-'))
  try {
    assert.deepEqual(readFirstRunState(dir), {}) // nothing persisted yet
    const at = '2026-07-08T12:00:00.000Z'
    markFirstRunShown(dir, at)
    assert.deepEqual(readFirstRunState(dir), { firstRunShownAt: at })
    assert.equal(firstRunStatePath(dir), path.join(dir, 'first-run.json'))
    // Simulate a second launch: state is present ⇒ shouldOpenSetup is now false.
    const already = readFirstRunState(dir).firstRunShownAt !== undefined
    assert.equal(shouldOpenSetup({ engineReachable: true, needsModelSetup: true, alreadyShown: already }), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the two first-run markers coexist — marking one preserves the other', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'openinfo-first-run-'))
  try {
    // Mic asked at first launch (before the engine is even reached) — the setup marker stays absent.
    markMicPrompted(dir, '2026-07-08T09:00:00.000Z')
    assert.deepEqual(readFirstRunState(dir), { micPromptedAt: '2026-07-08T09:00:00.000Z' })
    assert.equal(shouldPromptMic({ alreadyPrompted: readFirstRunState(dir).micPromptedAt !== undefined }), false)

    // Later /setup auto-opens — the mic marker must not be clobbered by the merge write.
    markFirstRunShown(dir, '2026-07-08T09:05:00.000Z')
    assert.deepEqual(readFirstRunState(dir), {
      micPromptedAt: '2026-07-08T09:00:00.000Z',
      firstRunShownAt: '2026-07-08T09:05:00.000Z',
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
