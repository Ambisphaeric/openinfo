import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveShellConfig } from './config.js'

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
