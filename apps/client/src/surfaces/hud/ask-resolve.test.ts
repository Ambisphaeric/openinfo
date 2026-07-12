import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Surface } from '@openinfo/contracts'
import { createAskResolveController, resolvePillAskSurface, NoChatFaceError, type AskResolveDeps } from './dev-entry.js'

/**
 * The Ask-face resolve RETRY controller (the fix for the one-shot resolve race): the packaged shell creates
 * the pill window BEFORE its bundled engine spawns, so the first GET /bundles typically loses that race —
 * the old one-shot `.then/.catch` made the loss permanent (setAskAvailable(false) forever; the Ask button,
 * which gates the whole chat box, dead on every packaged cold boot). These assert the retry ladder (the
 * boot controller's capped backoff), the flip to available once the engine answers, and the ONE terminal
 * stop — the typed NoChatFaceError (GET /bundles answered: no chat face) never retries, so a genuine
 * data answer cannot hammer the engine forever. All headless via an injected resolve + manual scheduler.
 */

/** A manual scheduler: retries run only when the test says time passed (the boot.test.ts idiom). */
const manualScheduler = () => {
  const queue: Array<{ fn: () => void; ms: number }> = []
  return {
    schedule: (fn: () => void, ms: number) => queue.push({ fn, ms }),
    /** run the next scheduled retry, returning its delay */
    tick: (): number | undefined => {
      const next = queue.shift()
      if (!next) return undefined
      next.fn()
      return next.ms
    },
    pending: () => queue.length,
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const chatSurface: Surface = {
  id: 'surf-openinfo-chat',
  name: 'Chat',
  context: 'any',
  version: 1,
  stack: [{ block: 'input', input: { target: 'chat', submit: '/chat' } }],
}

/** Collects every outcome so a test asserts the full observable story of a resolve run. */
const harness = (resolve: AskResolveDeps['resolve'], schedule: (fn: () => void, ms: number) => void) => {
  const events: { resolved: Surface[]; noChatFace: string[]; retries: Array<{ error: unknown; attempt: number }> } = {
    resolved: [],
    noChatFace: [],
    retries: [],
  }
  const controller = createAskResolveController({
    resolve,
    onResolved: (surface) => events.resolved.push(surface),
    onNoChatFace: (reason) => events.noChatFace.push(reason),
    onRetry: (error, attempt) => events.retries.push({ error, attempt }),
    schedule,
  })
  return { controller, events }
}

test('the spawn race: the resolve fails N times then succeeds — Ask ENABLES (the shipped bug never enabled)', async () => {
  const sched = manualScheduler()
  let failuresLeft = 3
  const { controller, events } = harness(
    () => (failuresLeft-- > 0 ? Promise.reject(new Error('Failed to fetch')) : Promise.resolve(chatSurface)),
    sched.schedule,
  )

  controller.start()
  await flush()
  // first loss of the race: logged with its attempt, retry scheduled at the boot ladder's first rung
  assert.equal(events.retries.length, 1)
  assert.equal(events.retries[0]!.attempt, 1)
  assert.equal(sched.tick(), 500)
  await flush()
  assert.equal(events.retries[1]!.attempt, 2)
  assert.equal(sched.tick(), 1_000)
  await flush()
  assert.equal(events.retries[2]!.attempt, 3)
  assert.equal(sched.tick(), 2_000)
  await flush()
  // the engine is up: the resolve lands, Ask flips available, nothing further is scheduled
  assert.equal(events.resolved.length, 1)
  assert.equal(events.resolved[0]!.id, 'surf-openinfo-chat')
  assert.deepEqual(events.noChatFace, [])
  assert.equal(sched.pending(), 0)
})

test('a long outage keeps retrying at the CAPPED rung — the same forever-posture as the boot controller', async () => {
  const sched = manualScheduler()
  const { controller, events } = harness(() => Promise.reject(new Error('Failed to fetch')), sched.schedule)
  controller.start()
  await flush()
  const delays: number[] = []
  for (let i = 0; i < 7; i += 1) {
    delays.push(sched.tick()!)
    await flush()
  }
  // the boot ladder, then the 8s cap forever — never a runaway hammer, never a give-up
  assert.deepEqual(delays, [500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000])
  assert.equal(events.retries.length, 8)
  assert.equal(sched.pending(), 1)
})

test('a GENUINE no-chat-face answer is TERMINAL: the honest reason lands once and nothing retries', async () => {
  const sched = manualScheduler()
  const { controller, events } = harness(() => Promise.reject(new NoChatFaceError('this app has no chat face')), sched.schedule)
  controller.start()
  await flush()
  assert.deepEqual(events.noChatFace, ['this app has no chat face'])
  assert.deepEqual(events.retries, [], 'a data answer is not retried')
  assert.equal(sched.pending(), 0, 'no retry hammering after the terminal stop')
  // a second start() after the terminal settle stays settled — no zombie loop
  controller.start()
  await flush()
  assert.deepEqual(events.noChatFace, ['this app has no chat face'])
  assert.equal(sched.pending(), 0)
})

test('the race then the data answer: transient failures retry UNTIL the bundle answers no-chat-face', async () => {
  const sched = manualScheduler()
  let failuresLeft = 2
  const { controller, events } = harness(
    () => Promise.reject(failuresLeft-- > 0 ? new Error('Failed to fetch') : new NoChatFaceError('this app has no chat face')),
    sched.schedule,
  )
  controller.start()
  await flush()
  sched.tick()
  await flush()
  sched.tick()
  await flush()
  assert.equal(events.retries.length, 2)
  assert.deepEqual(events.noChatFace, ['this app has no chat face'])
  assert.equal(sched.pending(), 0)
})

test('start() after a successful resolve is a no-op (no duplicate resolve loops)', async () => {
  const sched = manualScheduler()
  let calls = 0
  const { controller, events } = harness(() => {
    calls += 1
    return Promise.resolve(chatSurface)
  }, sched.schedule)
  controller.start()
  await flush()
  controller.start()
  await flush()
  assert.equal(calls, 1)
  assert.equal(events.resolved.length, 1)
})

// --- the transient/terminal distinction is a TYPE the resolver actually throws, not a message match ---

const fakeFetch = (body: unknown, ok = true, status = 200): typeof fetch =>
  (async () => ({ ok, status, json: async () => body })) as unknown as typeof fetch

const transport = { surface: async (id: string): Promise<Surface> => ({ ...chatSurface, id }) }

test('resolvePillAskSurface throws the TYPED NoChatFaceError only for the genuine data answer', async () => {
  // GET /bundles answered, no chat face in the data ⇒ the terminal type.
  const noFace = [{ id: 'b', name: 'B', version: 1, faces: [{ kind: 'hud', surfaceRef: 'surf-openinfo-pill' }] }]
  await assert.rejects(
    resolvePillAskSurface('http://e', transport, fakeFetch(noFace))('surf-openinfo-pill'),
    (error: unknown) => error instanceof NoChatFaceError,
  )
  // a failed /bundles read (the engine-spawn race face) is a PLAIN error — the retry loop keeps it alive.
  await assert.rejects(
    resolvePillAskSurface('http://e', transport, fakeFetch({}, false, 503))('surf-openinfo-pill'),
    (error: unknown) => error instanceof Error && !(error instanceof NoChatFaceError),
  )
})
