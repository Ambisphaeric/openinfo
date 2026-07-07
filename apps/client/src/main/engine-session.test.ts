import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Session } from '@openinfo/contracts'
import { EngineSessionClient, SessionLiveState, type FetchLike } from './engine-session.js'

const session = (over: Partial<Session> = {}): Session => ({
  id: 's1',
  workspaceId: 'default',
  modeId: 'mode-meeting',
  startedAt: '2026-07-07T00:00:00.000Z',
  attribution: { evidence: [], confidence: 1 },
  ...over,
})

/** A stub fetch that records calls and returns a canned JSON body. */
const stubFetch = (body: unknown, ok = true): { fetch: FetchLike; calls: Array<{ url: string; method: string | undefined; body: string | undefined }> } => {
  const calls: Array<{ url: string; method: string | undefined; body: string | undefined }> = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body })
    return { ok, status: ok ? 200 : 500, json: async () => body }
  }
  return { fetch, calls }
}

test('liveSession queries /sessions?live=true and returns the first', async () => {
  const { fetch, calls } = stubFetch([session()])
  const client = new EngineSessionClient('http://engine:8787/', fetch)
  const live = await client.liveSession('default')
  assert.equal(live?.id, 's1')
  assert.match(calls[0]!.url, /\/sessions\?workspace=default&live=true$/)
})

test('startSession POSTs a StartSessionRequest', async () => {
  const { fetch, calls } = stubFetch(session({ id: 's2' }))
  const client = new EngineSessionClient('http://engine:8787', fetch)
  const started = await client.startSession({ workspaceId: 'default', modeId: 'mode-meeting' })
  assert.equal(started.id, 's2')
  assert.equal(calls[0]!.method, 'POST')
  assert.equal(calls[0]!.url, 'http://engine:8787/sessions')
  assert.deepEqual(JSON.parse(calls[0]!.body!), { workspaceId: 'default', modeId: 'mode-meeting' })
})

test('endSession POSTs to /sessions/:id/end', async () => {
  const { fetch, calls } = stubFetch(session({ endedAt: '2026-07-07T01:00:00.000Z' }))
  const client = new EngineSessionClient('http://engine:8787', fetch)
  await client.endSession('s1')
  assert.equal(calls[0]!.url, 'http://engine:8787/sessions/s1/end')
  assert.equal(calls[0]!.method, 'POST')
})

test('a non-ok response throws', async () => {
  const { fetch } = stubFetch({}, false)
  const client = new EngineSessionClient('http://engine:8787', fetch)
  await assert.rejects(() => client.liveSession('default'))
})

test('SessionLiveState tracks live from WS events, scoped to its workspace', () => {
  const state = new SessionLiveState('default')
  const changes: boolean[] = []
  state.onChange((live) => changes.push(live))

  assert.equal(state.live, false)
  state.applyEvent({ name: 'session.started', payload: session({ id: 's1' }) })
  assert.equal(state.live, true)
  assert.equal(state.liveSessionId, 's1')

  // an event for another workspace is ignored
  state.applyEvent({ name: 'session.started', payload: session({ id: 's9', workspaceId: 'other' }) })
  assert.equal(state.liveSessionId, 's1')

  // ending a DIFFERENT session does not clear us
  state.applyEvent({ name: 'session.ended', payload: session({ id: 'sX' }) })
  assert.equal(state.live, true)

  // ending the live one clears
  state.applyEvent({ name: 'session.ended', payload: session({ id: 's1', endedAt: '2026-07-07T01:00:00.000Z' }) })
  assert.equal(state.live, false)
  assert.deepEqual(changes, [true, false])
})

test('seed sets live only for an unended session', () => {
  const a = new SessionLiveState('default')
  a.seed(session({ id: 's1' }))
  assert.equal(a.live, true)

  const b = new SessionLiveState('default')
  b.seed(session({ id: 's1', endedAt: '2026-07-07T01:00:00.000Z' }))
  assert.equal(b.live, false)

  const c = new SessionLiveState('default')
  c.seed(undefined)
  assert.equal(c.live, false)
})
