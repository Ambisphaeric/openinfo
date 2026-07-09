import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CaptureConsent } from './capture-consent.js'

test('boot guard: a fresh launch has NOT consented — a leftover live session must not auto-start capture', () => {
  const consent = new CaptureConsent()
  assert.equal(consent.canAutoStart, false)
})

test('an explicit Start grants consent; an explicit End revokes it', () => {
  const consent = new CaptureConsent()
  consent.grant()
  assert.equal(consent.canAutoStart, true)
  consent.revoke()
  assert.equal(consent.canAutoStart, false)
})

test('consent PERSISTS across an auto-end→restart (one Start gesture, ended+started WS pair)', () => {
  const consent = new CaptureConsent()
  consent.grant() // user clicks Start while a session is live → engine ends old, starts new
  // The two WS transitions do NOT touch consent, so the restarted session still captures.
  assert.equal(consent.canAutoStart, true)
})

test('quit revokes consent (a session ended on quit is never auto-resumed next launch)', () => {
  const consent = new CaptureConsent()
  consent.grant()
  consent.revoke() // shell calls this from before-quit
  assert.equal(consent.canAutoStart, false)
})
