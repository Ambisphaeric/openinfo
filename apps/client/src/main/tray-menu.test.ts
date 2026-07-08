import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTrayMenu, setupItemLabel, trayStatusLabel, trayTooltip, type TrayState } from './tray-menu.js'

const state = (over: Partial<TrayState> = {}): TrayState => ({ visible: false, sessionLive: false, connected: true, ...over })

const item = (menu: ReturnType<typeof buildTrayMenu>, id: string) => menu.find((m) => m.id === id)

test('window toggle flips Show ⇄ Hide with its command', () => {
  assert.equal(item(buildTrayMenu(state({ visible: false })), 'toggle-window')?.label, 'Show HUD')
  assert.equal(item(buildTrayMenu(state({ visible: false })), 'toggle-window')?.command, 'show-hud')
  assert.equal(item(buildTrayMenu(state({ visible: true })), 'toggle-window')?.label, 'Hide HUD')
  assert.equal(item(buildTrayMenu(state({ visible: true })), 'toggle-window')?.command, 'hide-hud')
})

test('session toggle flips Start ⇄ End with its command', () => {
  assert.equal(item(buildTrayMenu(state({ sessionLive: false })), 'toggle-session')?.label, 'Start Session')
  assert.equal(item(buildTrayMenu(state({ sessionLive: false })), 'toggle-session')?.command, 'start-session')
  assert.equal(item(buildTrayMenu(state({ sessionLive: true })), 'toggle-session')?.label, 'End Session')
  assert.equal(item(buildTrayMenu(state({ sessionLive: true })), 'toggle-session')?.command, 'end-session')
})

test('session toggle is disabled until the engine state is known', () => {
  assert.equal(item(buildTrayMenu(state({ connected: false })), 'toggle-session')?.enabled, false)
  assert.equal(item(buildTrayMenu(state({ connected: true })), 'toggle-session')?.enabled, true)
})

test('the status header + tooltip reflect live-session state', () => {
  assert.equal(trayStatusLabel(state({ sessionLive: true })), '● session live')
  assert.equal(trayStatusLabel(state({ sessionLive: false })), '○ no session')
  assert.equal(trayStatusLabel(state({ connected: false })), '○ connecting…')
  assert.match(trayTooltip(state({ sessionLive: true })), /live/)
  assert.match(trayTooltip(state({ sessionLive: false })), /idle/)
})

test('rec indicator only shows for real audio; starting is a distinct honest state', () => {
  // capturing = ● rec (real audio); micStarting = warming up (no rec claim yet).
  assert.equal(trayStatusLabel(state({ sessionLive: true, capturing: true })), '● session live · ● rec')
  assert.equal(trayStatusLabel(state({ sessionLive: true, micStarting: true })), '● session live · ○ mic…')
  assert.doesNotMatch(trayStatusLabel(state({ sessionLive: true, micStarting: true })), /rec/)
  assert.match(trayTooltip(state({ sessionLive: true, capturing: true })), /rec/)
  assert.match(trayTooltip(state({ sessionLive: true, micStarting: true })), /starting/)
})

test('the "Set up models…" item is prominent (⚠) only when the llm slot is empty', () => {
  assert.equal(setupItemLabel(true), '⚠ Set up models…')
  assert.equal(setupItemLabel(false), 'Set up models…')
  assert.equal(setupItemLabel(undefined), 'Set up models…') // unknown ⇒ quiet, no false alarm
  const prominent = item(buildTrayMenu(state({ needsModelSetup: true })), 'open-setup')
  assert.equal(prominent?.command, 'open-setup')
  assert.equal(prominent?.label, '⚠ Set up models…')
  assert.equal(prominent?.enabled, true)
  assert.equal(item(buildTrayMenu(state({ needsModelSetup: false })), 'open-setup')?.label, 'Set up models…')
})

test('quit is always present and enabled', () => {
  const q = item(buildTrayMenu(state()), 'quit')
  assert.equal(q?.command, 'quit')
  assert.equal(q?.enabled, true)
})
