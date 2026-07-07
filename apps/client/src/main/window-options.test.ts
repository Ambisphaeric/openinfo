import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hudWindowSpec } from './window-options.js'

test('the HUD window carries the inherited-Glass signature', () => {
  const spec = hudWindowSpec()
  const w = spec.browserWindow
  assert.equal(w.frame, false, 'frameless')
  assert.equal(w.transparent, true, 'transparent so only the glass panel shows')
  assert.equal(w.alwaysOnTop, true, 'always on top')
  assert.equal(w.resizable, false)
  assert.equal(w.skipTaskbar, true)
  assert.equal(w.focusable, false, 'a glance, never steals focus')
})

test('content protection + all-workspaces visibility are requested as hardening', () => {
  const spec = hudWindowSpec()
  assert.equal(spec.hardening.contentProtection, true, 'invisible to screen capture/share')
  assert.equal(spec.hardening.visibleOnAllWorkspaces, true)
  assert.equal(spec.hardening.visibleOnFullScreen, true)
})

test('the renderer is locked down (context isolation on, node integration off)', () => {
  const wp = hudWindowSpec().browserWindow.webPreferences
  assert.equal(wp.contextIsolation, true)
  assert.equal(wp.nodeIntegration, false)
  assert.equal(wp.backgroundThrottling, false, 'live HUD keeps updating while hidden')
})

test('opens hidden by default (Glass reveals with ⌘\\ / the tray); startVisible overrides', () => {
  assert.equal(hudWindowSpec().browserWindow.show, false)
  assert.equal(hudWindowSpec().startVisible, false)
  assert.equal(hudWindowSpec({ startVisible: true }).browserWindow.show, true)
})

test('window width wraps the 660px hud-v2 panel', () => {
  assert.ok(hudWindowSpec().browserWindow.width >= 660)
})
