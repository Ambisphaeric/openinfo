import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  decideEngineDisposition,
  checkEngineReachable,
  waitForEngine,
  bundledEngineEntry,
  portFromEngineUrl,
  fetchEngineHealth,
  compareVersions,
  engineStatusLine,
  assessEngineSkew,
  parseAllowSkew,
  buildStampPath,
  readBuildStamp,
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
    join('/Apps/openinfo.app/Contents/Resources', 'engine-bundle', 'apps', 'engine', 'dist', 'main.js'),
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

test('engineStatusLine: a reported build id is surfaced (no longer dropped) after the location', () => {
  assert.equal(
    engineStatusLine({ disposition: 'adopt', engineVersion: '0.0.11', appVersion: '0.0.11', engineUrl: 'http://127.0.0.1:8787', build: 'a1b2c3d' }),
    'engine v0.0.11 · adopted at :8787 · build a1b2c3d',
  )
})

test('engineStatusLine: a spawned engine surfaces its build too, before any skew note', () => {
  assert.equal(
    engineStatusLine({ disposition: 'spawn', engineVersion: '0.0.11', appVersion: '0.0.11', build: 'deadbee' }),
    'engine v0.0.11 · spawned (bundled) · build deadbee',
  )
})

test('engineStatusLine: build + skew both show (build before the skew note)', () => {
  assert.equal(
    engineStatusLine({ disposition: 'adopt', engineVersion: '0.0.10', appVersion: '0.0.11', engineUrl: 'http://127.0.0.1:8787', build: 'a1b2c3d' }),
    'engine v0.0.10 · adopted at :8787 · build a1b2c3d · older than this app (v0.0.11)',
  )
})

test('engineStatusLine: a blank build is not rendered (no dangling "· build ")', () => {
  assert.equal(
    engineStatusLine({ disposition: 'adopt', engineVersion: '0.0.11', appVersion: '0.0.11', engineUrl: 'http://127.0.0.1:8787', build: '  ' }),
    'engine v0.0.11 · adopted at :8787',
  )
})

test('assessEngineSkew: identical version + no builds ⇒ ADOPT (the normal dev/prod parity case)', () => {
  assert.deepEqual(assessEngineSkew({ appVersion: '0.0.11', engineVersion: '0.0.11', allowSkew: false }), {
    adopt: true,
    skewed: false,
    refused: false,
  })
})

test('assessEngineSkew: an OLDER adopted engine is REFUSED by default, with a plain reason', () => {
  const v = assessEngineSkew({ appVersion: '0.0.11', engineVersion: '0.0.10', allowSkew: false })
  assert.equal(v.adopt, false)
  assert.equal(v.refused, true)
  assert.equal(v.skewed, true)
  assert.match(v.reason ?? '', /older than this app \(v0\.0\.11\)/)
})

test('assessEngineSkew: a NEWER adopted engine is refused too (the stale-client-adopts-newer-engine case)', () => {
  const v = assessEngineSkew({ appVersion: '0.0.10', engineVersion: '0.0.11', allowSkew: false })
  assert.equal(v.refused, true)
  assert.match(v.reason ?? '', /newer than this app \(v0\.0\.10\)/)
})

test('assessEngineSkew: an engine reporting NO version (predates the field) is refused as an old build', () => {
  const v = assessEngineSkew({ appVersion: '0.0.11', allowSkew: false })
  assert.equal(v.refused, true)
  assert.match(v.reason ?? '', /predates version reporting/)
})

test('assessEngineSkew: SAME version, DIFFERENT build ⇒ refused (two builds of one version)', () => {
  const v = assessEngineSkew({ appVersion: '0.0.11', engineVersion: '0.0.11', appBuild: 'aaaaaaa', engineBuild: 'bbbbbbb', allowSkew: false })
  assert.equal(v.refused, true)
  assert.match(v.reason ?? '', /different sources/)
})

test('assessEngineSkew: same version, same build ⇒ adopt (a matched stamped pair)', () => {
  assert.deepEqual(
    assessEngineSkew({ appVersion: '0.0.11', engineVersion: '0.0.11', appBuild: 'aaaaaaa', engineBuild: 'aaaaaaa', allowSkew: false }),
    { adopt: true, skewed: false, refused: false },
  )
})

test('assessEngineSkew: a build present on only ONE side is NOT skew (a missing stamp is not evidence)', () => {
  assert.equal(assessEngineSkew({ appVersion: '0.0.11', engineVersion: '0.0.11', engineBuild: 'bbbbbbb', allowSkew: false }).skewed, false)
})

test('assessEngineSkew: the dev flag ADOPTS a mismatch (skewed:true, refused:false, reason retained for the warning)', () => {
  const v = assessEngineSkew({ appVersion: '0.0.11', engineVersion: '0.0.10', allowSkew: true })
  assert.equal(v.adopt, true)
  assert.equal(v.refused, false)
  assert.equal(v.skewed, true)
  assert.match(v.reason ?? '', /older than this app/)
})

test('assessEngineSkew: an unknown app version cannot honestly refuse ⇒ adopt (no fabricated skew)', () => {
  assert.deepEqual(assessEngineSkew({ engineVersion: '0.0.1', allowSkew: false }), { adopt: true, skewed: false, refused: false })
})

test('parseAllowSkew: only an explicit truthy token opts into skew adoption', () => {
  for (const yes of ['1', 'true', 'on', 'YES', ' True ']) assert.equal(parseAllowSkew(yes), true)
  for (const no of [undefined, '', '0', 'false', 'off', 'no', 'nonsense']) assert.equal(parseAllowSkew(no), false)
})

test('buildStampPath: the stamp lives beside the app resources', () => {
  assert.equal(buildStampPath('/Applications/openinfo.app/Contents/Resources'), join('/Applications/openinfo.app/Contents/Resources', 'build-stamp.json'))
})

test('readBuildStamp: reads {build} from the resources file (injected reader, no filesystem)', () => {
  assert.equal(readBuildStamp('/res', () => JSON.stringify({ build: 'a1b2c3d' })), 'a1b2c3d')
})

test('readBuildStamp: a missing/unreadable/malformed stamp ⇒ undefined (every dev run), never throws', () => {
  assert.equal(readBuildStamp('/res', () => { throw new Error('ENOENT') }), undefined)
  assert.equal(readBuildStamp('/res', () => 'not json'), undefined)
  assert.equal(readBuildStamp('/res', () => JSON.stringify({ build: '' })), undefined)
  assert.equal(readBuildStamp('/res', () => JSON.stringify({ build: 42 })), undefined)
})
