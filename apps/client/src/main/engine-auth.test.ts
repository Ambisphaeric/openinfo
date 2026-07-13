import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  configuredEngineCredentialSource,
  EngineAuthDiscovery,
  EngineAuthError,
  ProvisionedEngineCredential,
  engineDiscoveryPath,
  engineWebSocketProtocols,
  fetchEngineControl,
  maySendEngineCredential,
  type EngineAuthRecord,
  type EngineCredentialSource,
} from './engine-auth.js'

const TOKEN_A = 'A'.repeat(43)
const TOKEN_B = 'B'.repeat(43)

const record = (over: Partial<EngineAuthRecord> = {}): EngineAuthRecord => ({
  version: 1,
  instanceId: 'instance-1',
  pid: 1234,
  mode: 'local',
  bindHost: '127.0.0.1',
  port: 8787,
  baseUrl: 'http://127.0.0.1:8787',
  token: TOKEN_A,
  createdAt: '2026-07-13T00:00:00.000Z',
  ...over,
})

const fixture = async (): Promise<{ root: string; runDir: string; file: string }> => {
  const root = await mkdtemp(path.join(tmpdir(), 'openinfo-engine-auth-'))
  const runDir = path.join(root, 'run')
  await mkdir(runDir, { mode: 0o700 })
  await chmod(runDir, 0o700)
  return { root, runDir, file: path.join(runDir, 'engine-8787.json') }
}

test('discovery path is keyed by the configured effective port and honors the run-dir override', () => {
  assert.equal(engineDiscoveryPath('http://localhost:8787', { runDir: '/safe/run' }), '/safe/run/engine-8787.json')
  assert.equal(engineDiscoveryPath('https://control.example', { runDir: '/safe/run' }), '/safe/run/engine-443.json')
})

test('loads a private local record across loopback aliases, caches, then refreshes a rotated token', async () => {
  const f = await fixture()
  try {
    await writeFile(f.file, JSON.stringify({ ...record(), additiveFutureField: true }), { mode: 0o600 })
    await chmod(f.file, 0o600)
    const source = new EngineAuthDiscovery({ runDir: f.runDir })
    assert.deepEqual(await source.credentialFor('http://localhost:8787'), { token: TOKEN_A, instanceId: 'instance-1' })

    await writeFile(f.file, JSON.stringify(record({ instanceId: 'instance-2', token: TOKEN_B })), { mode: 0o600 })
    await chmod(f.file, 0o600)
    assert.equal((await source.credentialFor('http://localhost:8787'))?.token, TOKEN_A)
    assert.deepEqual(await source.credentialFor('http://localhost:8787', { refresh: true }), {
      token: TOKEN_B,
      instanceId: 'instance-2',
    })
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('loads a tunnel record only through its exact HTTPS public origin', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openinfo-engine-auth-tunnel-'))
  const runDir = path.join(root, 'run')
  await mkdir(runDir, { mode: 0o700 })
  await chmod(runDir, 0o700)
  const file = path.join(runDir, 'engine-443.json')
  try {
    await writeFile(file, JSON.stringify(record({
      mode: 'tunnel',
      port: 443,
      baseUrl: 'http://127.0.0.1:443',
      publicOrigin: 'https://control.example',
    })), { mode: 0o600 })
    await chmod(file, 0o600)
    const source = new EngineAuthDiscovery({ runDir })
    assert.equal((await source.credentialFor('https://control.example'))?.token, TOKEN_A)
    await assert.rejects(() => source.credentialFor('https://other.example'), EngineAuthError)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('missing records are unauthenticated, while group/world-readable files fail closed', async () => {
  const f = await fixture()
  try {
    const source = new EngineAuthDiscovery({ runDir: f.runDir })
    assert.equal(await source.credentialFor('http://127.0.0.1:8787'), undefined)
    await writeFile(f.file, JSON.stringify(record()), { mode: 0o644 })
    await chmod(f.file, 0o644)
    await assert.rejects(
      () => source.credentialFor('http://127.0.0.1:8787', { refresh: true }),
      (error: unknown) => error instanceof EngineAuthError && error.code === 'insecure-record',
    )
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('symlink and malformed records fail without including the token in the error', async () => {
  const f = await fixture()
  const target = path.join(f.root, 'target.json')
  try {
    await writeFile(target, JSON.stringify(record()), { mode: 0o600 })
    await symlink(target, f.file)
    const source = new EngineAuthDiscovery({ runDir: f.runDir })
    await assert.rejects(() => source.credentialFor('http://127.0.0.1:8787'), EngineAuthError)
    await rm(f.file)

    const secret = 'secret-that-must-not-appear'
    await writeFile(f.file, JSON.stringify({ ...record(), token: secret }), { mode: 0o600 })
    await chmod(f.file, 0o600)
    await assert.rejects(
      () => source.credentialFor('http://127.0.0.1:8787', { refresh: true }),
      (error: unknown) => error instanceof Error && !error.message.includes(secret),
    )
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('credentials may use plaintext only on loopback; provisioned tunnel credentials require HTTPS', async () => {
  assert.equal(maySendEngineCredential('http://127.9.8.7:8787'), true)
  assert.equal(maySendEngineCredential('http://[::1]:8787'), true)
  assert.equal(maySendEngineCredential('http://192.168.1.20:8787'), false)
  assert.equal(maySendEngineCredential('https://control.example'), true)
  assert.throws(() => new ProvisionedEngineCredential('http://192.168.1.20:8787', TOKEN_A), EngineAuthError)
  const provisionedToken = 'P'.repeat(32) // engine accepts provisioned URL-safe tokens at >=32 UTF-8 bytes
  const tunnel = new ProvisionedEngineCredential('https://control.example', provisionedToken)
  assert.equal((await tunnel.credentialFor('https://control.example'))?.token, provisionedToken)
  assert.equal(await tunnel.credentialFor('https://other.example'), undefined)
})

test('configured tunnel credentials come from explicit environment or a private token file', async () => {
  const inline = configuredEngineCredentialSource('https://control.example', {
    env: { OPENINFO_CONTROL_TOKEN: TOKEN_A },
  })
  assert.equal((await inline.credentialFor('https://control.example'))?.token, TOKEN_A)
  assert.equal(await inline.credentialFor('https://other.example'), undefined)

  const root = await mkdtemp(path.join(tmpdir(), 'openinfo-provisioned-token-'))
  const tokenFile = path.join(root, 'token')
  try {
    await writeFile(tokenFile, `${TOKEN_B}\n`, { mode: 0o600 })
    await chmod(tokenFile, 0o600)
    const file = configuredEngineCredentialSource('https://control.example', {
      env: { OPENINFO_CONTROL_TOKEN_FILE: tokenFile },
    })
    assert.equal((await file.credentialFor('https://control.example'))?.token, TOKEN_B)
    await chmod(tokenFile, 0o644)
    await assert.rejects(() => file.credentialFor('https://control.example', { refresh: true }), EngineAuthError)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('configured credentials reject ambiguous provisioning and insecure remote HTTP', () => {
  assert.throws(
    () => configuredEngineCredentialSource('https://control.example', {
      env: { OPENINFO_CONTROL_TOKEN: TOKEN_A, OPENINFO_CONTROL_TOKEN_FILE: '/private/token' },
    }),
    EngineAuthError,
  )
  assert.throws(
    () => configuredEngineCredentialSource('http://192.168.1.20:8787', {
      env: { OPENINFO_CONTROL_TOKEN: TOKEN_A },
    }),
    EngineAuthError,
  )
})

test('WS protocols carry the canonical token exactly once and never as a standalone protocol', () => {
  assert.deepEqual(engineWebSocketProtocols({ token: TOKEN_A }), ['openinfo.v1', `openinfo.auth.${TOKEN_A}`])
  assert.equal(engineWebSocketProtocols({ token: TOKEN_A }).includes(TOKEN_A), false)
})

test('HTTP auth injects Bearer and performs exactly one reload/retry on 401', async () => {
  const refreshes: Array<boolean | undefined> = []
  const credentials: EngineCredentialSource = {
    credentialFor: async (_baseUrl, options) => {
      refreshes.push(options?.refresh)
      return { token: options?.refresh ? TOKEN_B : TOKEN_A }
    },
  }
  const headers: Array<Record<string, string> | undefined> = []
  const response = await fetchEngineControl({
    baseUrl: 'http://127.0.0.1:8787',
    path: '/health',
    credentials,
    init: { method: 'GET' },
    fetchImpl: async (_url, init) => {
      headers.push(init?.headers)
      const status = headers.length === 1 ? 401 : 200
      return { ok: status === 200, status, json: async () => ({ ok: true }) }
    },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(refreshes, [undefined, true])
  assert.deepEqual(headers.map((value) => value?.['authorization']), [`Bearer ${TOKEN_A}`, `Bearer ${TOKEN_B}`])
})

test('a second 401 is returned without a third credential load or request', async () => {
  let loads = 0
  let calls = 0
  const response = await fetchEngineControl({
    baseUrl: 'http://127.0.0.1:8787',
    path: '/health',
    credentials: { credentialFor: async () => { loads += 1; return { token: TOKEN_A } } },
    init: { method: 'GET' },
    fetchImpl: async () => { calls += 1; return { ok: false, status: 401, json: async () => ({}) } },
  })
  assert.equal(response.status, 401)
  assert.equal(loads, 2)
  assert.equal(calls, 2)
})

test('even a custom source cannot send its credential over plaintext non-loopback HTTP', async () => {
  const secret = 'Z'.repeat(43)
  let fetched = false
  await assert.rejects(
    () => fetchEngineControl({
      baseUrl: 'http://192.168.1.20:8787',
      path: '/health',
      credentials: { credentialFor: async () => ({ token: secret }) },
      init: { method: 'GET' },
      fetchImpl: async () => {
        fetched = true
        return { ok: true, status: 200, json: async () => ({}) }
      },
    }),
    (error: unknown) => error instanceof EngineAuthError && error.code === 'insecure-origin' && !error.message.includes(secret),
  )
  assert.equal(fetched, false)
})

test('protected control requests fail closed before fetch when no credential exists', async () => {
  let fetched = false
  await assert.rejects(
    () => fetchEngineControl({
      baseUrl: 'http://127.0.0.1:8787',
      path: '/sessions',
      credentials: { credentialFor: async () => undefined },
      init: { method: 'GET' },
      fetchImpl: async () => {
        fetched = true
        return { ok: true, status: 200, json: async () => [] }
      },
    }),
    (error: unknown) => error instanceof EngineAuthError && error.code === 'missing-credential',
  )
  assert.equal(fetched, false)
})
