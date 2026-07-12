import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hudWindowSpec, configForSurface, surfaceWindowSpec } from './window-options.js'

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

test('the #100 fields app takes Glass chrome (content-protected companion) at its own narrower width', () => {
  const cfg = configForSurface('surf-openinfo-fields')
  assert.equal(cfg.chrome, 'hud', 'a sensitive-content companion beside the HUD, not a framed app window')
  assert.equal(cfg.width, 480, 'narrower than the HUD panel so the two sit side-by-side')
  // an unknown surface still falls through to the framed `app` default (disclosed)
  assert.equal(configForSurface('surf-unknown').chrome, 'app')
})

// ── S1: chat keyboard — the per-surface focusability override ─────────────────────────────────────────
test('S1: a HUD window is NON-focusable by default (a glance), but the focusable override flips only that flag', () => {
  assert.equal(hudWindowSpec().browserWindow.focusable, false, 'default HUD never steals focus')
  const chat = hudWindowSpec({ focusable: true })
  assert.equal(chat.browserWindow.focusable, true, 'a typed-in HUD surface can become the key window')
  // the rest of the Glass signature is untouched — focusability is orthogonal
  assert.equal(chat.browserWindow.frame, false)
  assert.equal(chat.browserWindow.transparent, true)
  assert.equal(chat.browserWindow.alwaysOnTop, true)
  assert.equal(chat.hardening.contentProtection, true)
})

test('S1: the chat surface declares focusable (else macOS NSBeeps every keystroke into a window that can never accept it)', () => {
  assert.equal(configForSurface('surf-openinfo-chat').focusable, true)
  // the read-only HUD glances do NOT opt in
  assert.notEqual(configForSurface('surf-openinfo-hud').focusable, true)
  assert.notEqual(configForSurface('surf-openinfo-fields').focusable, true)
})

test('S1: surfaceWindowSpec resolves chrome + width + focusability from the surface config in one place', () => {
  const chat = surfaceWindowSpec('surf-openinfo-chat', { startVisible: true })
  assert.equal(chat.browserWindow.focusable, true, 'chat opts into focus')
  assert.equal(chat.browserWindow.frame, false, 'chat is still HUD chrome')
  assert.equal(chat.browserWindow.show, true)

  const fields = surfaceWindowSpec('surf-openinfo-fields')
  assert.equal(fields.browserWindow.width, 480, 'width override honored')
  assert.equal(fields.browserWindow.focusable, false, 'a content-only HUD companion stays a glance')

  const diag = surfaceWindowSpec('surf-openinfo-diagnostics')
  assert.equal(diag.browserWindow.frame, true, 'diagnostics is framed app chrome')
  assert.equal(diag.browserWindow.focusable, true, 'framed app windows are always focusable')
  assert.equal(diag.browserWindow.width, 560)
})
