import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveShellConfig, parseClientConfigFile, loadClientConfigFile, clientConfigPath } from './config.js'

test('defaults to localhost:8787 and the meeting mode when the env is empty', () => {
  const cfg = resolveShellConfig({})
  assert.equal(cfg.engineUrl, 'http://127.0.0.1:8787')
  assert.equal(cfg.workspace, 'default')
  assert.equal(cfg.modeId, 'mode-meeting')
  assert.equal(cfg.surfaceId, 'surf-openinfo-hud')
})

test('OPENINFO_PORT and host build the engine URL', () => {
  const cfg = resolveShellConfig({ OPENINFO_PORT: '9000', OPENINFO_ENGINE_HOST: '192.168.1.5' })
  assert.equal(cfg.engineUrl, 'http://192.168.1.5:9000')
})

test('an explicit OPENINFO_ENGINE_URL wins and is trailing-slash-trimmed', () => {
  const cfg = resolveShellConfig({ OPENINFO_ENGINE_URL: 'http://box.local:8080/', OPENINFO_PORT: '9000' })
  assert.equal(cfg.engineUrl, 'http://box.local:8080')
})

test('workspace / mode / surface are overridable', () => {
  const cfg = resolveShellConfig({ OPENINFO_WORKSPACE: 'sales', OPENINFO_MODE: 'mode-x', OPENINFO_SURFACE: 'surf-y' })
  assert.equal(cfg.workspace, 'sales')
  assert.equal(cfg.modeId, 'mode-x')
  assert.equal(cfg.surfaceId, 'surf-y')
})

test('mic + system-audio capture are opt-OUT: default ON, disabled only by an explicit falsy token', () => {
  const on = resolveShellConfig({})
  assert.equal(on.micEnabled, true)
  assert.equal(on.systemAudioEnabled, true) // default ON — but a no-op unless a virtual device is present
  for (const off of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.equal(resolveShellConfig({ OPENINFO_MIC: off }).micEnabled, false)
    assert.equal(resolveShellConfig({ OPENINFO_SYSTEM_AUDIO: off }).systemAudioEnabled, false)
  }
  // Any other value leaves capture ON (only the explicit tokens disable).
  assert.equal(resolveShellConfig({ OPENINFO_SYSTEM_AUDIO: '1' }).systemAudioEnabled, true)
  // The two toggles are independent.
  const micOnly = resolveShellConfig({ OPENINFO_SYSTEM_AUDIO: 'off' })
  assert.equal(micOnly.micEnabled, true)
  assert.equal(micOnly.systemAudioEnabled, false)
})

test('focus watching is opt-OUT: default ON, disabled only by an explicit falsy OPENINFO_FOCUS token', () => {
  assert.equal(resolveShellConfig({}).focusEnabled, true) // default ON — but a no-op unless route.detect is also on
  for (const off of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.equal(resolveShellConfig({ OPENINFO_FOCUS: off }).focusEnabled, false)
  }
  assert.equal(resolveShellConfig({ OPENINFO_FOCUS: '1' }).focusEnabled, true) // any other value leaves it on
})

test('screen capture is opt-IN: default OFF, enabled only by an explicit truthy OPENINFO_SCREEN token', () => {
  assert.equal(resolveShellConfig({}).screenEnabled, false) // privacy-heavy → OFF unless explicitly asked
  for (const on of ['1', 'true', 'on', 'yes', 'YES']) {
    assert.equal(resolveShellConfig({ OPENINFO_SCREEN: on }).screenEnabled, true)
  }
  for (const off of ['0', 'false', 'off', 'no', '', 'garbage']) {
    assert.equal(resolveShellConfig({ OPENINFO_SCREEN: off }).screenEnabled, false) // anything non-truthy stays OFF
  }
  // The asymmetry: audio/focus default ON, screen defaults OFF — in the very same empty env.
  const empty = resolveShellConfig({})
  assert.equal(empty.micEnabled, true)
  assert.equal(empty.screenEnabled, false)
})

test('screen cadence defaults to 5000ms and is overridable; junk/non-positive falls back to the default', () => {
  assert.equal(resolveShellConfig({}).screenIntervalMs, 5000)
  assert.equal(resolveShellConfig({ OPENINFO_SCREEN_INTERVAL_MS: '2000' }).screenIntervalMs, 2000)
  for (const bad of ['0', '-5', 'nope', '']) {
    assert.equal(resolveShellConfig({ OPENINFO_SCREEN_INTERVAL_MS: bad }).screenIntervalMs, 5000)
  }
})

// --- packaged-app config file (~/.openinfo/client.json) ---

test('a client.json file supplies defaults when the env is empty (the packaged-app config story)', () => {
  const cfg = resolveShellConfig({}, { engineUrl: 'http://box.local:8917', workspace: 'sales', modeId: 'mode-x', surfaceId: 'surf-y' })
  assert.equal(cfg.engineUrl, 'http://box.local:8917')
  assert.equal(cfg.workspace, 'sales')
  assert.equal(cfg.modeId, 'mode-x')
  assert.equal(cfg.surfaceId, 'surf-y')
})

test('env WINS over the file (precedence env > file > defaults)', () => {
  const file = { engineUrl: 'http://box.local:8917', workspace: 'sales' }
  const cfg = resolveShellConfig({ OPENINFO_ENGINE_URL: 'http://127.0.0.1:9999', OPENINFO_WORKSPACE: 'env-ws' }, file)
  assert.equal(cfg.engineUrl, 'http://127.0.0.1:9999') // env url wins
  assert.equal(cfg.workspace, 'env-ws') // env workspace wins
})

test('env host/port compose an engine URL that beats the file url', () => {
  const cfg = resolveShellConfig({ OPENINFO_PORT: '9000' }, { engineUrl: 'http://box.local:8917' })
  assert.equal(cfg.engineUrl, 'http://127.0.0.1:9000')
})

test('defaults are the floor when neither env nor file provides a value', () => {
  const cfg = resolveShellConfig({}, { workspace: 'only-ws' })
  assert.equal(cfg.engineUrl, 'http://127.0.0.1:8787') // no url anywhere ⇒ default
  assert.equal(cfg.modeId, 'mode-meeting')
})

test('a client.json trailing slash on engineUrl is trimmed', () => {
  const cfg = resolveShellConfig({}, { engineUrl: 'http://box.local:8917/' })
  assert.equal(cfg.engineUrl, 'http://box.local:8917')
})

test('file capture toggles are honoured; an explicit env token still overrides them', () => {
  assert.equal(resolveShellConfig({}, { mic: false }).micEnabled, false) // file can disable
  assert.equal(resolveShellConfig({ OPENINFO_MIC: '1' }, { mic: false }).micEnabled, true) // env re-enables
  assert.equal(resolveShellConfig({}, { focus: false, systemAudio: false }).focusEnabled, false)
  assert.equal(resolveShellConfig({}, {}).micEnabled, true) // absent in file ⇒ default ON
})

test('file can opt IN to screen and set the cadence; env still wins (opt-in precedence env > file > OFF)', () => {
  assert.equal(resolveShellConfig({}, { screen: true }).screenEnabled, true) // file can enable the opt-in
  assert.equal(resolveShellConfig({ OPENINFO_SCREEN: '0' }, { screen: true }).screenEnabled, false) // env disables
  assert.equal(resolveShellConfig({}, {}).screenEnabled, false) // absent everywhere ⇒ default OFF
  assert.equal(resolveShellConfig({}, { screenIntervalMs: 3000 }).screenIntervalMs, 3000) // file cadence honoured
  assert.equal(resolveShellConfig({ OPENINFO_SCREEN_INTERVAL_MS: '1500' }, { screenIntervalMs: 3000 }).screenIntervalMs, 1500) // env wins
})

test('parseClientConfigFile keeps valid fields and drops junk/wrong types (never crashes the shell)', () => {
  assert.deepEqual(parseClientConfigFile({ engineUrl: 'http://x', mic: false, bogus: 1 }), { engineUrl: 'http://x', mic: false })
  assert.deepEqual(parseClientConfigFile({ engineUrl: 42, workspace: 'ok', mic: 'yes' }), { workspace: 'ok' }) // wrong types dropped
  assert.equal(parseClientConfigFile(null), undefined)
  assert.equal(parseClientConfigFile([1, 2]), undefined) // arrays are not config objects
  assert.equal(parseClientConfigFile('nope'), undefined)
  assert.deepEqual(parseClientConfigFile({}), {}) // empty object is a valid (empty) override
})

test('parseClientConfigFile parses screen (bool) + screenIntervalMs (number) and drops wrong types', () => {
  assert.deepEqual(parseClientConfigFile({ screen: true, screenIntervalMs: 3000 }), { screen: true, screenIntervalMs: 3000 })
  assert.deepEqual(parseClientConfigFile({ screen: 'yes', screenIntervalMs: '3000' }), {}) // wrong types dropped
})

test('loadClientConfigFile round-trips a real file and swallows a missing/malformed one', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'openinfo-client-config-'))
  try {
    const p = path.join(dir, 'client.json')
    writeFileSync(p, JSON.stringify({ engineUrl: 'http://box.local:8917', focus: false }), 'utf8')
    assert.deepEqual(loadClientConfigFile(p), { engineUrl: 'http://box.local:8917', focus: false })
    assert.equal(loadClientConfigFile(path.join(dir, 'missing.json')), undefined) // no file ⇒ undefined
    writeFileSync(p, '{ not json', 'utf8')
    assert.equal(loadClientConfigFile(p), undefined) // malformed ⇒ undefined, no throw
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('clientConfigPath is ~/.openinfo/client.json under the given home', () => {
  assert.equal(clientConfigPath('/Users/x'), path.join('/Users/x', '.openinfo', 'client.json'))
})

test('hudOutline is opt-IN debug chrome: default OFF, env token or file boolean enables, env wins', () => {
  assert.equal(resolveShellConfig({}).hudOutline, false) // debug chrome → OFF unless explicitly asked
  assert.equal(resolveShellConfig({ OPENINFO_HUD_OUTLINE: '1' }).hudOutline, true)
  assert.equal(resolveShellConfig({ OPENINFO_HUD_OUTLINE: 'yes' }).hudOutline, true)
  assert.equal(resolveShellConfig({ OPENINFO_HUD_OUTLINE: '0' }).hudOutline, false)
  assert.equal(resolveShellConfig({}, { hudOutline: true }).hudOutline, true) // client.json can enable it
  assert.equal(resolveShellConfig({ OPENINFO_HUD_OUTLINE: '0' }, { hudOutline: true }).hudOutline, false) // env wins
  assert.deepEqual(parseClientConfigFile({ hudOutline: true }), { hudOutline: true })
  assert.deepEqual(parseClientConfigFile({ hudOutline: 'yes' }), {}) // wrong type dropped
})
