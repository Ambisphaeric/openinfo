import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ScreenCaptureObservation } from '@openinfo/contracts'
import { runScreenCaptureAttempt, screenPermissionDeniedObservation, type ScreenCaptureAttemptResult } from './screen-observation.js'

const context = { workspaceId: 'workspace-1', sessionId: 'session-1' }
const occurredAt = '2026-07-13T10:11:12.345Z'
const observationId = 'observation-1'

const run = async (
  capture: () => Promise<ScreenCaptureAttemptResult>,
  observe: (observation: ScreenCaptureObservation) => Promise<unknown> = async () => undefined,
): Promise<ScreenCaptureObservation> => runScreenCaptureAttempt({
  context,
  capture: async ({ observationId: seenId, occurredAt: seenAt }) => {
    assert.equal(seenId, observationId, 'one attempt id is reused inside the capture edge')
    assert.equal(seenAt, occurredAt, 'one attempt timestamp is reused inside the capture edge')
    return capture()
  },
  observe,
  now: () => occurredAt,
  newId: () => observationId,
})

test('screen attempt reports queued only after durable capture accepts the exact image chunk', async () => {
  const seen: ScreenCaptureObservation[] = []
  const observation = await run(
    async () => ({ outcome: 'accepted', capture: { id: 'scr-session-1-000001', capturedAt: occurredAt, ...context } }),
    async (value) => void seen.push(value),
  )
  assert.deepEqual(observation, {
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    outcome: 'queued',
    capture: { id: 'scr-session-1-000001', capturedAt: occurredAt },
  })
  assert.deepEqual(seen, [observation])
})

test('queued provenance follows the accepted chunk if the session flips during an async attempt', async () => {
  const observation = await runScreenCaptureAttempt({
    context: { workspaceId: 'workspace-new', sessionId: 'session-new' },
    capture: async () => ({
      outcome: 'accepted',
      capture: {
        id: 'scr-session-old-000001',
        capturedAt: occurredAt,
        workspaceId: 'workspace-old',
        sessionId: 'session-old',
      },
    }),
    observe: async () => undefined,
    now: () => occurredAt,
    newId: () => observationId,
  })
  assert.deepEqual(observation, {
    workspaceId: 'workspace-old',
    sessionId: 'session-old',
    outcome: 'queued',
    capture: { id: 'scr-session-old-000001', capturedAt: occurredAt },
  })
})

test('screen attempt reports a delta rejection without claiming a capture was queued', async () => {
  assert.deepEqual(await run(async () => ({ outcome: 'delta-skipped' })), {
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    outcome: 'delta-skipped',
    observationId,
    occurredAt,
  })
})

test('screen attempt reports an empty grab as grab-failed', async () => {
  assert.deepEqual(await run(async () => undefined), {
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    outcome: 'grab-failed',
    observationId,
    occurredAt,
  })
})

test('screen attempt reports a thrown grab/durable-capture failure and never claims queued', async () => {
  assert.deepEqual(await run(async () => {
    throw new Error('pixel transport unavailable')
  }), {
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    outcome: 'grab-failed',
    observationId,
    occurredAt,
  })
})

test('screen observation transport failure is harmless after capture', async () => {
  const observation = await run(
    async () => ({ outcome: 'accepted', capture: { id: 'scr-session-1-000001', capturedAt: occurredAt, ...context } }),
    async () => {
      throw new Error('engine restarted')
    },
  )
  assert.equal(observation.outcome, 'queued')
})

test('a never-resolving observation request cannot hold the physical screen attempt open', async () => {
  const attempt = run(
    async () => ({ outcome: 'accepted', capture: { id: 'scr-session-1-000001', capturedAt: occurredAt, ...context } }),
    () => new Promise(() => undefined),
  )
  const observation = await Promise.race([
    attempt,
    new Promise<never>((_resolve, reject) => setImmediate(() => reject(new Error('attempt remained blocked on telemetry')))),
  ])
  assert.equal(observation.outcome, 'queued')
})

test('a refused screen run builds one closed permission-denied report from its exact session context (#192)', () => {
  assert.deepEqual(
    screenPermissionDeniedObservation(context, { now: () => occurredAt, newId: () => observationId }),
    {
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      outcome: 'permission-denied',
      observationId,
      occurredAt,
    },
  )
  // Defaults mint a fresh attempt id and wall-clock — the report is never reused across runs.
  const generated = screenPermissionDeniedObservation(context)
  assert.equal(generated.outcome, 'permission-denied')
  if (generated.outcome === 'permission-denied') {
    assert.match(generated.observationId, /^screen-observation-/)
    assert.ok(Number.isFinite(Date.parse(generated.occurredAt)))
  }
  // Metadata only: exactly the closed correlation fields, never a TCC status or error string.
  assert.deepEqual(Object.keys(generated).sort(), ['observationId', 'occurredAt', 'outcome', 'sessionId', 'workspaceId'])
})
