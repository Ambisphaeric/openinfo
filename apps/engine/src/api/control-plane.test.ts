import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  controlTokenDigest,
  generateControlToken,
  isLoopbackControlHost,
  isPublicHealthRequest,
  resolveControlPlane,
  validateControlToken,
  type ControlPlaneDiscoveryRecord,
} from './control-plane.js'

const TOKEN_A = 'a'.repeat(43)
const TOKEN_B = 'b'.repeat(43)
const NOW = new Date('2026-07-12T12:34:56.000Z')

const local = (env: Record<string, string | undefined> = {}, homeDir = '/tmp/openinfo-control-home') =>
  resolveControlPlane({
    env,
    homeDir,
    now: () => NOW,
    pid: 4242,
    makeInstanceId: () => 'instance-local-1',
    makeToken: () => TOKEN_A,
  })

test('local defaults are authenticated, per-launch, and deterministically loopback-only', () => {
  const control = local()
  assert.equal(control.mode, 'local')
  assert.equal(control.bindHost, '127.0.0.1')
  assert.equal(control.port, 8787)
  assert.equal(control.baseUrl, 'http://127.0.0.1:8787')
  assert.equal(control.tokenSource, 'generated')
  assert.equal(control.discoveryPath, resolve('/tmp/openinfo-control-home', '.openinfo', 'run', 'engine-8787.json'))
  assert.equal(control.authenticate(TOKEN_A), true)
  assert.equal(control.authenticate(TOKEN_B), false)
  assert.equal(control.authenticate(undefined), false)
  assert.deepEqual(control.publicPolicy(), {
    authRequired: true,
    instanceId: 'instance-local-1',
    mode: 'local',
    transport: 'loopback-http',
  })
  assert.equal(JSON.stringify(control.publicPolicy()).includes(TOKEN_A), false)
})

test('generated tokens carry exactly 256 random bits as 43 URL-safe base64 characters', () => {
  const a = generateControlToken()
  const b = generateControlToken()
  assert.match(a, /^[A-Za-z0-9_-]{43}$/)
  assert.match(b, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(a, b)
  assert.equal(Buffer.from(a, 'base64url').byteLength, 32)
})

test('token comparison hashes to a fixed width and rejects missing, wrong, and prefix candidates', () => {
  const digest = controlTokenDigest(TOKEN_A)
  assert.equal(digest.byteLength, 32)
  assert.equal(validateControlToken(digest, TOKEN_A), true)
  assert.equal(validateControlToken(digest, TOKEN_B), false)
  assert.equal(validateControlToken(digest, TOKEN_A.slice(0, -1)), false)
  assert.equal(validateControlToken(digest, undefined), false)
})

test('only loopback bind hosts are accepted; localhost normalizes to deterministic IPv4', () => {
  assert.equal(local({ OPENINFO_BIND_HOST: 'localhost' }).bindHost, '127.0.0.1')
  assert.equal(local({ OPENINFO_BIND_HOST: '::1' }).bindHost, '::1')
  assert.equal(local({ OPENINFO_BIND_HOST: '127.4.5.6' }).bindHost, '127.4.5.6')
  for (const host of ['0.0.0.0', '::', '192.168.1.9', 'worker.local', '8.8.8.8']) {
    assert.throws(() => local({ OPENINFO_BIND_HOST: host }), /refusing non-loopback/)
  }
  assert.equal(isLoopbackControlHost('127.255.0.1'), true)
  assert.equal(isLoopbackControlHost('127.999.0.1'), false)
  assert.equal(isLoopbackControlHost('localhost'), true)
})

test('invalid modes and ports fail before a server can be constructed', () => {
  assert.throws(() => local({ OPENINFO_CONTROL_MODE: 'remote' }), /local.*tunnel/)
  for (const port of ['0', '-1', '65536', '1.2', 'nope']) {
    assert.throws(() => local({ OPENINFO_PORT: port }), /OPENINFO_PORT/)
  }
})

test('tunnel mode requires an HTTPS public origin and an explicitly provisioned token', () => {
  assert.throws(() => local({ OPENINFO_CONTROL_MODE: 'tunnel' }), /PUBLIC_ORIGIN/)
  assert.throws(
    () => local({ OPENINFO_CONTROL_MODE: 'tunnel', OPENINFO_PUBLIC_ORIGIN: 'https://control.example.test' }),
    /requires OPENINFO_CONTROL_TOKEN/,
  )
  assert.throws(
    () => local({ OPENINFO_CONTROL_MODE: 'tunnel', OPENINFO_PUBLIC_ORIGIN: 'http://control.example.test', OPENINFO_CONTROL_TOKEN: TOKEN_A }),
    /requires an https/,
  )
  for (const origin of ['https://user@control.example.test', 'https://control.example.test/path', 'not a url']) {
    assert.throws(
      () => local({ OPENINFO_CONTROL_MODE: 'tunnel', OPENINFO_PUBLIC_ORIGIN: origin, OPENINFO_CONTROL_TOKEN: TOKEN_A }),
      /OPENINFO_PUBLIC_ORIGIN/,
    )
  }

  const control = local({
    OPENINFO_CONTROL_MODE: 'tunnel',
    OPENINFO_PUBLIC_ORIGIN: 'https://control.example.test:9443/',
    OPENINFO_CONTROL_TOKEN: TOKEN_A,
  })
  assert.equal(control.bindHost, '127.0.0.1')
  assert.equal(control.baseUrl, 'http://127.0.0.1:8787')
  assert.equal(control.publicOrigin, 'https://control.example.test:9443')
  assert.equal(control.tokenSource, 'environment')
  assert.equal(control.publicPolicy().transport, 'trusted-tunnel-https')
})

test('local mode rejects a public origin instead of silently becoming remote', () => {
  assert.throws(() => local({ OPENINFO_PUBLIC_ORIGIN: 'https://control.example.test' }), /valid only.*tunnel/)
})

test('provisioned tokens must be URL-safe, at least 32 bytes, and unambiguous', () => {
  assert.throws(() => local({ OPENINFO_CONTROL_TOKEN: 'short' }), /at least 32 bytes/)
  assert.throws(() => local({ OPENINFO_CONTROL_TOKEN: `${'a'.repeat(42)}+` }), /URL-safe/)
  assert.throws(
    () => local({ OPENINFO_CONTROL_TOKEN: TOKEN_A, OPENINFO_CONTROL_TOKEN_FILE: '/tmp/nope' }),
    /set only one/,
  )
})

test('a provisioned token file must be a chmod-600 regular file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-control-token-'))
  const file = join(dir, 'token')
  try {
    await writeFile(file, `${TOKEN_A}\n`, { mode: 0o600 })
    await chmod(file, 0o600)
    const control = local({ OPENINFO_CONTROL_TOKEN_FILE: file }, dir)
    assert.equal(control.tokenSource, 'file')
    assert.equal(control.authenticate(TOKEN_A), true)
    if (process.platform !== 'win32') {
      await chmod(file, 0o644)
      assert.throws(() => local({ OPENINFO_CONTROL_TOKEN_FILE: file }, dir), /chmod 600/)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a provisioned token file symlink is refused before its target is read', async () => {
  if (process.platform === 'win32') return
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-control-token-link-'))
  const target = join(dir, 'target')
  const link = join(dir, 'token')
  try {
    await writeFile(target, `${TOKEN_A}\n`, { mode: 0o600 })
    await chmod(target, 0o600)
    await symlink(target, link)
    assert.throws(() => local({ OPENINFO_CONTROL_TOKEN_FILE: link }, dir))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('host policy rejects DNS-rebinding names and wrong ports even when auth is separate', () => {
  const control = local()
  for (const host of ['127.0.0.1:8787', 'localhost:8787', '127.9.8.7:8787', '[::1]:8787']) {
    assert.equal(control.validateHost(host), true, host)
  }
  for (const host of [undefined, '', 'attacker.example:8787', '192.168.1.9:8787', '0.0.0.0:8787', 'localhost:9999', 'user@localhost:8787']) {
    assert.equal(control.validateHost(host), false, String(host))
  }
})

test('tunnel host policy admits only its exact HTTPS authority plus the internal loopback authority', () => {
  const control = local({
    OPENINFO_CONTROL_MODE: 'tunnel',
    OPENINFO_PUBLIC_ORIGIN: 'https://control.example.test:9443',
    OPENINFO_CONTROL_TOKEN: TOKEN_A,
  })
  assert.equal(control.validateHost('control.example.test:9443'), true)
  assert.equal(control.validateHost('CONTROL.EXAMPLE.TEST:9443'), true)
  assert.equal(control.validateHost('127.0.0.1:8787'), true)
  assert.equal(control.validateHost('control.example.test'), false)
  assert.equal(control.validateHost('other.example.test:9443'), false)
})

test('origin policy is exact; local opaque origins still require the independent token check', () => {
  const control = local({ OPENINFO_ALLOWED_ORIGINS: 'http://localhost:3000, https://dev.example.test' })
  for (const origin of [undefined, 'null', 'file://', 'http://localhost:8787', 'http://127.0.0.1:8787', 'http://localhost:3000', 'https://dev.example.test']) {
    assert.equal(control.validateOrigin(origin), true, String(origin))
  }
  for (const origin of ['https://attacker.example', 'http://localhost:9999', 'https://dev.example.test/path', 'not an origin']) {
    assert.equal(control.validateOrigin(origin), false, origin)
  }
})

test('the WS adapter is structurally fail-closed for auth, Host, and Origin', () => {
  const socket = local().eventSocketPolicy()
  assert.equal(socket.authenticate(TOKEN_A), true)
  assert.equal(socket.authenticate(TOKEN_B), false)
  assert.equal(socket.validateHost('attacker.example:8787'), false)
  assert.equal(socket.validateOrigin('https://attacker.example'), false)
})

test('only GET /health is publicly classifiable', () => {
  assert.equal(isPublicHealthRequest('GET', '/health'), true)
  assert.equal(isPublicHealthRequest('GET', '/health?probe=1'), true)
  assert.equal(isPublicHealthRequest('POST', '/health'), false)
  assert.equal(isPublicHealthRequest('GET', '/health/extra'), false)
  assert.equal(isPublicHealthRequest('GET', '/flags'), false)
})

test('discovery publication is atomic, mode-0700/0600, per-port, and contains the exact v1 shape', async () => {
  const home = await mkdtemp(join(tmpdir(), 'openinfo-control-discovery-'))
  try {
    const control = local({ OPENINFO_PORT: '8899' }, home)
    const record = await control.publishDiscovery()
    assert.equal(control.discoveryPath, join(home, '.openinfo', 'run', 'engine-8899.json'))
    assert.deepEqual(record, {
      version: 1,
      instanceId: 'instance-local-1',
      pid: 4242,
      mode: 'local',
      bindHost: '127.0.0.1',
      port: 8899,
      baseUrl: 'http://127.0.0.1:8899',
      token: TOKEN_A,
      createdAt: NOW.toISOString(),
    } satisfies ControlPlaneDiscoveryRecord)
    assert.deepEqual(JSON.parse(await readFile(control.discoveryPath, 'utf8')), record)
    if (process.platform !== 'win32') {
      assert.equal((await stat(join(home, '.openinfo', 'run'))).mode & 0o777, 0o700)
      assert.equal((await stat(control.discoveryPath)).mode & 0o777, 0o600)
    }
    const runFiles = await import('node:fs/promises').then(({ readdir }) => readdir(join(home, '.openinfo', 'run')))
    assert.deepEqual(runFiles, ['engine-8899.json'])
    assert.equal(await control.cleanupDiscovery(), true)
    await assert.rejects(() => readFile(control.discoveryPath), /ENOENT/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('cleanup never removes a discovery record owned by a later engine instance', async () => {
  const home = await mkdtemp(join(tmpdir(), 'openinfo-control-cleanup-'))
  try {
    const old = local({ OPENINFO_PORT: '8900' }, home)
    await old.publishDiscovery()
    const replacement = { ...old.discoveryRecord(), instanceId: 'instance-newer-2', token: TOKEN_B }
    await writeFile(old.discoveryPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 })
    assert.equal(await old.cleanupDiscovery(), false)
    assert.equal((JSON.parse(await readFile(old.discoveryPath, 'utf8')) as { instanceId: string }).instanceId, 'instance-newer-2')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
