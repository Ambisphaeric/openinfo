import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SHORTCUTS } from './shortcuts.js'

test('⌘\\ (CommandOrControl+\\) toggles HUD visibility — the inherited Glass bind', () => {
  const bind = SHORTCUTS.find((s) => s.command === 'toggle-visibility')
  assert.ok(bind, 'a toggle-visibility binding exists')
  assert.equal(bind?.accelerator, 'CommandOrControl+\\')
})
