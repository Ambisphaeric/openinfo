import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MIC_SETTINGS_URL,
  ACCESSIBILITY_SETTINGS_URL,
  SCREEN_SETTINGS_URL,
  LOCAL_NETWORK_SETTINGS_URL,
  settingsUrlFor,
  isLanEngine,
} from './permission-help.js'

test('the Settings deep links are the documented x-apple.systempreferences Privacy_* form', () => {
  assert.match(MIC_SETTINGS_URL, /^x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_Microphone$/)
  assert.match(ACCESSIBILITY_SETTINGS_URL, /^x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_Accessibility$/)
  assert.match(SCREEN_SETTINGS_URL, /^x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_ScreenCapture$/)
  assert.match(LOCAL_NETWORK_SETTINGS_URL, /^x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_LocalNetwork$/)
})

test('settingsUrlFor maps each fix-it command to its pane', () => {
  assert.equal(settingsUrlFor('open-mic-settings'), MIC_SETTINGS_URL)
  assert.equal(settingsUrlFor('open-accessibility-settings'), ACCESSIBILITY_SETTINGS_URL)
  assert.equal(settingsUrlFor('open-screen-settings'), SCREEN_SETTINGS_URL)
})

test('isLanEngine is false for loopback and true for a LAN / remote host', () => {
  for (const local of ['http://localhost:8787', 'http://127.0.0.1:8917', 'http://[::1]:8787', 'http://0.0.0.0:8787']) {
    assert.equal(isLanEngine(local), false, local)
  }
  for (const lan of ['http://192.168.1.5:8787', 'http://studio.local:8917', 'http://box.example.com:8080']) {
    assert.equal(isLanEngine(lan), true, lan)
  }
})

test('isLanEngine never invents a hint from an unparseable url', () => {
  assert.equal(isLanEngine('not a url'), false)
  assert.equal(isLanEngine(''), false)
})
