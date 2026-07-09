import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideEngineDisposition,
  checkEngineReachable,
  waitForEngine,
  bundledEngineEntry,
  portFromEngineUrl,
  fetchEngineHealth,
  compareVersions,
  engineStatusLine,
  type FetchLike,
  type HealthFetchLike,
} from './engine-supervisor.js'

test('decision: a reachable engine is ADOPTED (spawn nothing), whatever the bundle', () => {
  assert.equal(decideEngineDisposition({ reachable: true, bundledEnginePresent: true }), 'adopt')
  assert.equal(decideEngineDisposition({ reachable: true, bundledEnginePresent: false }), 'adopt')
})

test('decision: unreachable + a bundled engine ⇒ SPAWN', () => {
  assert.equal(decideEngineDisposition({ reachable: false, bundledEnginePresent: true }), 'spawn')
})

test('decision: unreachable + no bundle ⇒ UNREACHABLE (the tray fallback state)', () => {
  assert.equal(decideEngineDisposition({ reachable: false, bundledEnginePresent: false }), 'unreachable')
})

test('checkEngineReachable: an ok /health response ⇒ true, and it hits {url}/health', async () => {
  let seen: string | undefined
  const fetchImpl: FetchLike = async (url) => {
    seen = url
    return { ok: true }
  }
  assert.equal(await checkEngineReachable('http://127.0.0.1:8787', { fetchImpl }), true)
  assert.equal(seen, 'http://127.0.0.1:8787/health')
})

test('checkEngineReachable: a trailing slash is normalized (no doubled //health)', async () => {
  let seen: string | undefined
  const fetchImpl: FetchLike = async (url) => {
    seen = url
    return { ok: true }
  }
  await checkEngineReachable('http://127.0.0.1:8787/', { fetchImpl })
  assert.equal(seen, 'http://127.0.0.1:8787/health')
})

test('checkEngineReachable: a non-ok response ⇒ false', async () => {
  const fetchImpl: FetchLike = async () => ({ ok: false })
  assert.equal(await checkEngineReachable('http://127.0.0.1:8787', { fetchImpl }), false)
})

test('checkEngineReachable: a thrown/refused connection ⇒ false (no engine here)', async () => {
  const fetchImpl: FetchLike = async () => {
    throw new Error('ECONNREFUSED')
  }
  assert.equal(await checkEngineReachable('http://127.0.0.1:8787', { fetchImpl }), false)
})

test('checkEngineReachable: a hung host is aborted by the timeout ⇒ false', async () => {
  // A fetch that only rejects when its signal aborts — proves the timeout drives the false, not the fetch.
  const fetchImpl: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })
  assert.equal(await checkEngineReachable('http://10.255.255.1:8787', { fetchImpl, timeoutMs: 20 }), false)
})

test('waitForEngine: resolves true once a later attempt answers (fake sleeper, no real timers)', async () => {
  let calls = 0
  const fetchImpl: FetchLike = async () => ({ ok: ++calls >= 3 }) // first two fail, third answers
  const ok = await waitForEngine('http://127.0.0.1:8787', {
    fetchImpl,
    attempts: 5,
    sleep: async () => {},
  })
  assert.equal(ok, true)
  assert.equal(calls, 3)
})

test('waitForEngine: gives up false after the attempt budget', async () => {
  let calls = 0
  const fetchImpl: FetchLike = async () => {
    calls++
    return { ok: false }
  }
  const ok = await waitForEngine('http://127.0.0.1:8787', { fetchImpl, attempts: 4, sleep: async () => {} })
  assert.equal(ok, false)
  assert.equal(calls, 4)
})

test('bundledEngineEntry: repo-shaped path under resourcesPath so the engine data-file paths resolve', () => {
  assert.equal(
    bundledEngineEntry('/Apps/openinfo.app/Contents/Resources'),
    '/Apps/openinfo.app/Contents/Resources/engine-bundle/apps/engine/dist/main.js',
  )
})

test('portFromEngineUrl: parses the explicit port; falls back to 8787 otherwise', () => {
  assert.equal(portFromEngineUrl('http://127.0.0.1:8787'), 8787)
  assert.equal(portFromEngineUrl('http://127.0.0.1:9001'), 9001)
  assert.equal(portFromEngineUrl('http://127.0.0.1'), 8787) // no explicit port ⇒ engine default
  assert.equal(portFromEngineUrl('not a url'), 8787)
})

// --- version handshake (slice 1) -----------------------------------------------------------------

test('compareVersions: orders by segment, treats missing trailing segments as 0', () => {
  assert.equal(compareVersions('0.0.1', '0.0.2'), -1)
  assert.equal(compareVersions('0.0.2', '0.0.1'), 1)
  assert.equal(compareVersions('0.0.1', '0.0.1'), 0)
  assert.equal(compareVersions('0.0', '0.0.0'), 0) // "0.0" == "0.0.0"
  assert.equal(compareVersions('1.0.0', '0.9.9'), 1)
  assert.equal(compareVersions('0.1.0', '0.0.9'), 1) // minor bump beats a higher patch
})

test('compareVersions: prerelease/build suffixes are stripped; garbage ⇒ undefined', () => {
  assert.equal(compareVersions('0.0.1-rc.1', '0.0.1'), 0)
  assert.equal(compareVersions('0.0.1+build9', '0.0.1'), 0)
  assert.equal(compareVersions('not-a-version', '0.0.1'), undefined)
  assert.equal(compareVersions('0.0.1', 'nope'), undefined)
})

test('fetchEngineHealth: reads version + build from an ok /health body, hitting {url}/health', async () => {
  let seen: string | undefined
  const fetchImpl: HealthFetchLike = async (url) => {
    seen = url
    return { ok: true, json: async () => ({ ok: true, phase: 1, version: '0.0.1', build: 'abc123' }) }
  }
  const health = await fetchEngineHealth('http://127.0.0.1:8787/', { fetchImpl })
  assert.equal(seen, 'http://127.0.0.1:8787/health')
  assert.deepEqual(health, { version: '0.0.1', build: 'abc123' })
})

test('fetchEngineHealth: an engine that omits version (older, predates the field) ⇒ {}', async () => {
  const fetchImpl: HealthFetchLike = async () => ({ ok: true, json: async () => ({ ok: true, phase: 1 }) })
  assert.deepEqual(await fetchEngineHealth('http://127.0.0.1:8787', { fetchImpl }), {})
})

test('fetchEngineHealth: a non-ok response or a thrown fetch ⇒ {} (best-effort, never throws)', async () => {
  const nonOk: HealthFetchLike = async () => ({ ok: false, json: async () => ({}) })
  assert.deepEqual(await fetchEngineHealth('http://127.0.0.1:8787', { fetchImpl: nonOk }), {})
  const thrown: HealthFetchLike = async () => {
    throw new Error('ECONNREFUSED')
  }
  assert.deepEqual(await fetchEngineHealth('http://127.0.0.1:8787', { fetchImpl: thrown }), {})
})

test('engineStatusLine: adopted engine shows version + port', () => {
  assert.equal(
    engineStatusLine({ disposition: 'adopt', engineVersion: '0.0.1', appVersion: '0.0.1', engineUrl: 'http://127.0.0.1:8787' }),
    'engine v0.0.1 · adopted at :8787',
  )
})

test('engineStatusLine: spawned bundled engine says so (no port suffix)', () => {
  assert.equal(
    engineStatusLine({ disposition: 'spawn', engineVersion: '0.0.1', appVersion: '0.0.1', engineUrl: 'http://127.0.0.1:8787' }),
    'engine v0.0.1 · spawned (bundled)',
  )
})

test('engineStatusLine: an OLDER adopted engine makes the skew plain', () => {
  assert.equal(
    engineStatusLine({ disposition: 'adopt', engineVersion: '0.0.1', appVersion: '0.0.2', engineUrl: 'http://127.0.0.1:8787' }),
    'engine v0.0.1 · adopted at :8787 · older than this app (v0.0.2)',
  )
})

test('engineStatusLine: a newer adopted engine is called out too', () => {
  assert.equal(
    engineStatusLine({ disposition: 'adopt', engineVersion: '0.1.0', appVersion: '0.0.2', engineUrl: 'http://127.0.0.1:8787' }),
    'engine v0.1.0 · adopted at :8787 · newer than this app (v0.0.2)',
  )
})

test('engineStatusLine: an adopted engine that reports NO version reads as predating the handshake', () => {
  assert.equal(
    engineStatusLine({ disposition: 'adopt', appVersion: '0.0.1', engineUrl: 'http://127.0.0.1:8787' }),
    "engine version unknown · adopted at :8787 · predates this app's version reporting",
  )
})

test('engineStatusLine: unreachable ⇒ undefined (the tray already leads with unreachable)', () => {
  assert.equal(engineStatusLine({ disposition: 'unreachable', appVersion: '0.0.1' }), undefined)
})
