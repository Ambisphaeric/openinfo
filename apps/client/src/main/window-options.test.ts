import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  hudWindowSpec,
  configForSurface,
  surfaceWindowSpec,
  surfaceWindowWidth,
  windowTitleFor,
  windowContract,
  assertWindowContract,
  MIN_HUD_FIT_WIDTH,
  SURFACE_WINDOW_CONFIG,
} from './window-options.js'

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

// ── S4: window identity — per-surface titles ──────────────────────────────────────────────────────────
test('S4: every surface names itself with a DISTINCT, non-generic title (not all "openinfo — HUD")', () => {
  assert.equal(windowTitleFor('surf-openinfo-hud'), 'openinfo — HUD')
  assert.equal(windowTitleFor('surf-openinfo-diagnostics'), 'openinfo — Diagnostics')
  assert.equal(windowTitleFor('surf-openinfo-chat'), 'openinfo — Chat')
  assert.equal(windowTitleFor('surf-openinfo-notetaker'), 'openinfo — Meeting Notes')
  // an unknown surface is humanized from its id, so it still self-identifies without a code change
  assert.equal(windowTitleFor('surf-openinfo-widget-shop'), 'openinfo — Widget Shop')
  // the framed apps (diagnostics + note-taker) no longer collide on the HUD title — the reported bug
  assert.notEqual(windowTitleFor('surf-openinfo-diagnostics'), windowTitleFor('surf-openinfo-hud'))
})

// ── S5 + policy item 3: the window contract, enforced in the factory ──────────────────────────────────
test('S5: every SHIPPED surface holds the window contract — it resizes OR provably fits, and self-identifies', () => {
  for (const surfaceId of Object.keys(SURFACE_WINDOW_CONFIG)) {
    const c = windowContract(surfaceId)
    assert.equal(c.ok, true, `${surfaceId} violates the window contract: ${JSON.stringify(c)}`)
    assert.ok(c.resizable || c.fitsWidth, `${surfaceId} neither resizes nor fits`)
    assert.ok(c.title.length > 0, `${surfaceId} has no self-identifying title`)
    assert.doesNotThrow(() => assertWindowContract(surfaceId))
  }
})

test('S5: surfaceWindowWidth reflects the override, else the chrome default', () => {
  assert.equal(surfaceWindowWidth('surf-openinfo-fields'), 480, 'declared override')
  assert.equal(surfaceWindowWidth('surf-openinfo-sidebar'), 320)
  assert.ok(surfaceWindowWidth('surf-openinfo-hud') >= 660, 'the default HUD wraps the 660px panel')
  assert.equal(surfaceWindowWidth('surf-unknown'), 520, 'app-chrome default width')
})

test('S5: a fixed-size (non-resizable) HUD window narrower than the fit floor FAILS the contract loudly', () => {
  // Register a degenerate too-narrow non-resizable HUD surface and prove the factory guard would reject it.
  const NARROW = 'surf-openinfo-too-narrow-hud'
  SURFACE_WINDOW_CONFIG[NARROW] = { chrome: 'hud', width: MIN_HUD_FIT_WIDTH - 40 }
  try {
    const c = windowContract(NARROW)
    assert.equal(c.resizable, false, 'HUD chrome does not resize')
    assert.equal(c.fitsWidth, false, 'below the fit floor it cannot provably fit')
    assert.equal(c.ok, false)
    assert.throws(() => assertWindowContract(NARROW), /window contract violated/)
  } finally {
    delete SURFACE_WINDOW_CONFIG[NARROW]
  }
})
