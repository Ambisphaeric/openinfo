import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CaptureChunk, ScreenCaptureObservation, SenseLaneSnapshot, Session } from '@openinfo/contracts'
import {
  createSecureTestEngineApp,
  secureTestFetch as fetch,
  TEST_CONTROL_TOKEN,
  testWsProtocols,
} from './test-control-plane.js'

const eventually = async (assertion: () => void, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      assertion()
      return
    } catch (error) {
      last = error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  throw last
}

test('screen observation POST is authenticated, closed, idempotent, and emits only safe live-lane metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-screen-observations-'))
  const app = createSecureTestEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  const address = app.server.address()
  assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  const events: Array<{ name: string; payload: Record<string, unknown> }> = []
  const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/events`, testWsProtocols())
  socket.addEventListener('message', (message) => {
    events.push(JSON.parse(String(message.data)) as { name: string; payload: Record<string, unknown> })
  })

  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new Error('event socket failed')), { once: true })
    })

    const preSession: ScreenCaptureObservation = {
      workspaceId: 'default', sessionId: 'not-live', outcome: 'delta-skipped',
      observationId: 'attempt-unauthenticated', occurredAt: '2026-07-13T12:00:00.000Z',
    }
    const unauthenticated = await globalThis.fetch(`${base}/screen/observations`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(preSession),
    })
    assert.equal(unauthenticated.status, 401)
    const wrongMediaType = await globalThis.fetch(`${base}/screen/observations`, {
      method: 'POST', headers: { authorization: `Bearer ${TEST_CONTROL_TOKEN}` }, body: JSON.stringify(preSession),
    })
    assert.equal(wrongMediaType.status, 415)

    const started = (await (await fetch(`${base}/sessions`, {
      method: 'POST', body: JSON.stringify({ workspaceId: 'default', modeId: 'mode-meeting' }),
    })).json()) as Session

    const forbidden = 'PRIVATE_SCREEN_OBSERVATION_SENTINEL'
    const invalid = await fetch(`${base}/screen/observations`, {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: 'default', sessionId: started.id, outcome: 'delta-skipped',
        observationId: 'attempt-invalid', occurredAt: '2026-07-13T12:00:00.500Z',
        data: forbidden, text: forbidden, error: forbidden,
      }),
    })
    assert.equal(invalid.status, 400, 'closed schema rejects pixels, derived text, and arbitrary errors')

    const raw = 'RAW_SCREEN_BYTES_NEVER_ENTER_LANE_EVENTS'
    const capture: CaptureChunk = {
      id: 'screen-observed-1', sessionId: started.id, workspaceId: 'default', source: 'screen', sequence: 1,
      capturedAt: '2026-07-13T12:00:01.000Z', contentType: 'image/jpeg', encoding: 'base64',
      data: Buffer.from(raw).toString('base64'),
    }
    assert.equal((await fetch(`${base}/capture/screen`, { method: 'POST', body: JSON.stringify(capture) })).status, 200)

    const queued: ScreenCaptureObservation = {
      workspaceId: 'default', sessionId: started.id, outcome: 'queued',
      capture: { id: capture.id, capturedAt: capture.capturedAt },
    }
    let response = await fetch(`${base}/screen/observations`, { method: 'POST', body: JSON.stringify(queued) })
    assert.equal(response.status, 200)
    let snapshot = (await response.json()) as SenseLaneSnapshot
    assert.equal(snapshot.source, 'screen')
    assert.equal(snapshot.disposition, 'queued')
    assert.equal(snapshot.health, 'healthy')
    assert.deepEqual(snapshot.latestCapture, queued.capture)
    if (snapshot.source === 'screen') assert.equal(snapshot.latestObservation, undefined, 'queued derivation stays on latestCapture')

    const skipped: ScreenCaptureObservation = {
      workspaceId: 'default', sessionId: started.id, outcome: 'delta-skipped',
      observationId: 'attempt-skipped', occurredAt: '2026-07-13T12:00:02.000Z',
    }
    response = await fetch(`${base}/screen/observations`, { method: 'POST', body: JSON.stringify(skipped) })
    assert.equal(response.status, 200)
    snapshot = (await response.json()) as SenseLaneSnapshot
    assert.deepEqual([snapshot.disposition, snapshot.health, snapshot.reason], ['delta-skipped', 'healthy', 'delta-skipped'])
    assert.equal(snapshot.source, 'screen')
    if (snapshot.source === 'screen') {
      assert.deepEqual(snapshot.latestObservation, {
        id: skipped.observationId, occurredAt: skipped.occurredAt, outcome: 'delta-skipped',
      })
    }

    const failed: ScreenCaptureObservation = {
      workspaceId: 'default', sessionId: started.id, outcome: 'grab-failed',
      observationId: 'attempt-failed', occurredAt: '2026-07-13T12:00:03.000Z',
    }
    response = await fetch(`${base}/screen/observations`, { method: 'POST', body: JSON.stringify(failed) })
    assert.equal(response.status, 200)
    snapshot = (await response.json()) as SenseLaneSnapshot
    assert.deepEqual([snapshot.disposition, snapshot.health, snapshot.reason], ['failed', 'failed', 'capture-failed'])
    assert.equal(snapshot.source, 'screen')
    if (snapshot.source === 'screen') {
      assert.deepEqual(snapshot.latestObservation, {
        id: failed.observationId, occurredAt: failed.occurredAt, outcome: 'grab-failed',
      })
    }

    // Three session-start rows + capture receipt + queued confirmation + skip + failure = seven exact
    // transitions. Wait for delivery before replaying so this is an actual idempotency proof, not a race.
    await eventually(() => {
      assert.equal(events.filter((event) => event.name === 'sense.lane.updated').length, 7)
    })

    // A replay is a 200/current-row acknowledgement, but produces no second state transition.
    response = await fetch(`${base}/screen/observations`, { method: 'POST', body: JSON.stringify(failed) })
    assert.equal(response.status, 200)
    assert.equal(((await response.json()) as SenseLaneSnapshot).reason, 'capture-failed')

    // session.switched is a public delivery barrier registered before the tracker subscriber. Replaying
    // this exact active Session is itself a tracker no-op, so once it arrives every earlier lane event has
    // arrived and the count must remain exactly seven.
    await app.bus.publish('session.switched', started)
    await eventually(() => {
      assert.equal(events.filter((event) => event.name === 'session.switched').length, 1)
    })
    const laneEvents = events.filter((event) => event.name === 'sense.lane.updated')
    assert.equal(laneEvents.length, 7, 'duplicate observation emitted no lane transition')
    assert.deepEqual(
      laneEvents.find((event) => event.payload['reason'] === 'delta-skipped')?.payload['latestObservation'],
      { id: skipped.observationId, occurredAt: skipped.occurredAt, outcome: 'delta-skipped' },
      'public event preserves the exact metadata derivation of a displayed delta skip',
    )
    assert.deepEqual(
      laneEvents.find((event) => event.payload['reason'] === 'capture-failed')?.payload['latestObservation'],
      { id: failed.observationId, occurredAt: failed.occurredAt, outcome: 'grab-failed' },
      'public event preserves the exact metadata derivation of a displayed failed grab',
    )
    const serialized = JSON.stringify(laneEvents)
    assert.equal(serialized.includes(forbidden), false)
    assert.equal(serialized.includes(raw), false)
    assert.equal(serialized.includes(capture.data), false)
    for (const event of laneEvents) {
      for (const key of ['data', 'text', 'preview', 'hash', 'error', 'blocks', 'deltaScore']) {
        assert.equal(key in event.payload, false, `${key} is absent from sense.lane.updated`)
      }
    }
  } finally {
    socket.close()
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})
