import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ContextHealthTracker, needsAccessibilityGrant } from './context-health.js'

test('needsAccessibilityGrant fires only when active, sampled, and no title seen', () => {
  assert.equal(needsAccessibilityGrant({ active: true, sampled: true, sawTitle: false }), true)
  assert.equal(needsAccessibilityGrant({ active: true, sampled: true, sawTitle: true }), false) // working
  assert.equal(needsAccessibilityGrant({ active: true, sampled: false, sawTitle: false }), false) // not sampled yet
  assert.equal(needsAccessibilityGrant({ active: false, sampled: true, sawTitle: false }), false) // not watching
})

test('a tracker never hints before polling, hints after a title-less sample, clears once a title arrives', () => {
  const t = new ContextHealthTracker()
  assert.equal(t.needsAccessibility, false) // idle
  t.setActive(true)
  assert.equal(t.needsAccessibility, false) // active but not yet sampled
  t.observe(undefined) // osascript read failed (Accessibility denied)
  assert.equal(t.needsAccessibility, true)
  t.observe({ app: 'Terminal' }) // app read but no title (still no usable context)
  assert.equal(t.needsAccessibility, true)
  t.observe({ app: 'Cursor', windowTitle: 'shell.ts — openinfo' }) // a real title — working
  assert.equal(t.needsAccessibility, false)
})

test('going inactive resets the observation window (a re-enable re-evaluates)', () => {
  const t = new ContextHealthTracker()
  t.setActive(true)
  t.observe(undefined)
  assert.equal(t.needsAccessibility, true)
  t.setActive(false)
  assert.equal(t.needsAccessibility, false) // stopped watching ⇒ no hint
  t.setActive(true)
  assert.equal(t.needsAccessibility, false) // fresh window, nothing sampled yet
})

test('observing while inactive is ignored', () => {
  const t = new ContextHealthTracker()
  t.observe(undefined)
  assert.equal(t.needsAccessibility, false)
})
