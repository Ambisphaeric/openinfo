import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTrayMenu, recSourcesLabel, senseDot, setupItemLabel, trayStatusLabel, trayTooltip, type TrayState } from './tray-menu.js'

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

test('the engine version handshake line renders as a disabled info item when present', () => {
  const line = 'engine v0.0.1 · adopted at :8787'
  const info = item(buildTrayMenu(state({ engineInfoLine: line })), 'engine-info')
  assert.equal(info?.label, line)
  assert.equal(info?.enabled, false)
})

test('no engine-info item when the handshake line is absent (e.g. unreachable / not yet resolved)', () => {
  assert.equal(item(buildTrayMenu(state({})), 'engine-info'), undefined)
})

test('the status header + tooltip reflect live-session state', () => {
  assert.equal(trayStatusLabel(state({ sessionLive: true })), '● session live')
  assert.equal(trayStatusLabel(state({ sessionLive: false })), '○ no session')
  assert.equal(trayStatusLabel(state({ connected: false })), '○ connecting…')
  assert.match(trayTooltip(state({ sessionLive: true })), /live/)
  assert.match(trayTooltip(state({ sessionLive: false })), /idle/)
})

test('the tooltip gains a quiet "· watching context" note when focus polling is active (session or not)', () => {
  assert.match(trayTooltip(state({ watchingContext: true })), /watching context/) // no session — focus is independent
  assert.match(trayTooltip(state({ sessionLive: true, watchingContext: true })), /session live · watching context/)
  assert.doesNotMatch(trayTooltip(state({ watchingContext: false })), /watching context/) // nothing when off
  assert.doesNotMatch(trayTooltip(state({ sessionLive: true })), /watching context/)
})

test('rec indicator only shows for real audio; starting is a distinct honest state', () => {
  // capturing = ● rec (real audio); micStarting = warming up (no rec claim yet).
  assert.equal(trayStatusLabel(state({ sessionLive: true, capturing: true })), '● session live · ● rec (mic only)')
  assert.equal(trayStatusLabel(state({ sessionLive: true, micStarting: true })), '● session live · ○ mic…')
  assert.doesNotMatch(trayStatusLabel(state({ sessionLive: true, micStarting: true })), /rec/)
  assert.match(trayTooltip(state({ sessionLive: true, capturing: true })), /rec/)
  assert.match(trayTooltip(state({ sessionLive: true, micStarting: true })), /starting/)
})

test('rec indicator names the sources honestly: mic only vs mic + system vs system silent', () => {
  const cap = (over: Partial<TrayState>) => trayStatusLabel(state({ sessionLive: true, capturing: true, ...over }))
  // No system device (or not capturing) → mic only.
  assert.equal(recSourcesLabel(state({ capturing: true })), 'mic only')
  assert.equal(cap({}), '● session live · ● rec (mic only)')
  // System audio genuinely flowing → mic + system.
  assert.equal(recSourcesLabel(state({ capturing: true, systemCapturing: true })), 'mic + system')
  assert.equal(cap({ systemCapturing: true }), '● session live · ● rec (mic + system)')
  // System device present but nothing routed (pure silence) → say so, don't pretend to record it.
  assert.equal(recSourcesLabel(state({ capturing: true, systemCapturing: true, systemSilent: true })), 'mic; system silent')
  assert.equal(cap({ systemCapturing: true, systemSilent: true }), '● session live · ● rec (mic; system silent)')
  // The tooltip mirrors the same source honesty.
  assert.match(trayTooltip(state({ sessionLive: true, capturing: true, systemCapturing: true })), /mic \+ system/)
  assert.match(trayTooltip(state({ sessionLive: true, capturing: true, systemCapturing: true, systemSilent: true })), /system silent/)
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

test('engine-unreachable is distinguished from first-boot connecting, and shows the URL it tried', () => {
  // Not yet tried ⇒ transient connecting state (no false alarm).
  assert.equal(trayStatusLabel(state({ connected: false })), '○ connecting…')
  assert.match(trayTooltip(state({ connected: false })), /connecting/)
  // Tried and failed ⇒ lead with the honest unreachable state + the URL.
  const tried = state({ connected: false, engineTried: true, engineUrl: 'http://127.0.0.1:8917' })
  assert.equal(trayStatusLabel(tried), '⚠ engine unreachable — http://127.0.0.1:8917')
  assert.match(trayTooltip(tried), /engine unreachable \(http:\/\/127\.0\.0\.1:8917\)/)
})

test('a LAN engine that is unreachable gets an honest Local Network hint (loopback does not)', () => {
  const lan = state({ connected: false, engineTried: true, engineUrl: 'http://studio.local:8917', lanEngine: true })
  assert.match(trayTooltip(lan), /check Local Network permission\?/)
  const local = state({ connected: false, engineTried: true, engineUrl: 'http://127.0.0.1:8917', lanEngine: false })
  assert.doesNotMatch(trayTooltip(local), /Local Network/)
})

test('the mic-blocked fix-it appears only when blocked and opens the mic Settings pane', () => {
  assert.equal(item(buildTrayMenu(state({ micBlocked: true })), 'fix-mic')?.command, 'open-mic-settings')
  assert.match(item(buildTrayMenu(state({ micBlocked: true })), 'fix-mic')?.label ?? '', /Microphone blocked/)
  assert.equal(item(buildTrayMenu(state({ micBlocked: false })), 'fix-mic'), undefined) // hidden when not blocked
  assert.equal(item(buildTrayMenu(state()), 'fix-mic'), undefined)
})

test('the Accessibility fix-it appears only when context detection is on-but-title-less', () => {
  assert.equal(item(buildTrayMenu(state({ accessibilityHint: true })), 'fix-accessibility')?.command, 'open-accessibility-settings')
  assert.match(item(buildTrayMenu(state({ accessibilityHint: true })), 'fix-accessibility')?.label ?? '', /Accessibility/)
  assert.equal(item(buildTrayMenu(state()), 'fix-accessibility'), undefined) // hidden by default
})

test('the Capture-status submenu appears only when a readout is present, and carries per-sense lines + fix-its', () => {
  // No readout ⇒ no submenu (e.g. before the first paint).
  assert.equal(item(buildTrayMenu(state()), 'capture-status'), undefined)

  const captureStatus = [
    { sense: 'mic' as const, label: 'Microphone', level: 'denied' as const, state: 'denied', detail: 'Access was refused.', fixCommand: 'open-mic-settings' as const },
    { sense: 'screen' as const, label: 'Screen recording', level: 'not-determined' as const, state: 'not granted', detail: 'No in-app prompt — RELAUNCH.', fixCommand: 'open-screen-settings' as const },
    { sense: 'sys-audio' as const, label: 'System audio', level: 'missing-device' as const, state: 'no device', detail: 'No loopback device.' },
  ]
  const menu = buildTrayMenu(state({ captureStatus }))
  const submenu = item(menu, 'capture-status')?.submenu
  assert.ok(submenu, 'capture-status item has a submenu')
  // Each sense contributes a disabled status line + a disabled detail line.
  assert.match(submenu!.find((m) => m.id === 'cap-mic')?.label ?? '', /Microphone — denied/)
  assert.equal(submenu!.find((m) => m.id === 'cap-mic')?.enabled, false)
  assert.match(submenu!.find((m) => m.id === 'cap-mic-detail')?.label ?? '', /Access was refused/)
  // The senses the OS won't popup for expose an enabled one-click Settings link with the right command.
  assert.equal(submenu!.find((m) => m.id === 'cap-mic-fix')?.command, 'open-mic-settings')
  assert.equal(submenu!.find((m) => m.id === 'cap-screen-fix')?.command, 'open-screen-settings')
  // A missing loopback device has no OS pane to open — no fix-it, only the honest detail line.
  assert.equal(submenu!.find((m) => m.id === 'cap-sys-audio-fix'), undefined)
  assert.match(submenu!.find((m) => m.id === 'cap-sys-audio-detail')?.label ?? '', /loopback/)
})

test('senseDot maps levels to at-a-glance glyphs', () => {
  assert.equal(senseDot('granted'), '●')
  assert.equal(senseDot('denied'), '⚠')
  assert.equal(senseDot('not-determined'), '○')
  assert.equal(senseDot('missing-device'), '○')
  assert.equal(senseDot('unsupported'), '·')
})

test('quit is always present and enabled', () => {
  const q = item(buildTrayMenu(state()), 'quit')
  assert.equal(q?.command, 'quit')
  assert.equal(q?.enabled, true)
})
