import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideEngineDisposition,
  checkEngineReachable,
  waitForEngine,
  bundledEngineEntry,
  portFromEngineUrl,
  type FetchLike,
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
