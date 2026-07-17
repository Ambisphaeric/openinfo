import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Fabric, Session } from '@openinfo/contracts'
import { EngineSessionClient, SessionLiveState, needsModelSetup, type FetchLike } from './engine-session.js'
import type { EngineCredentialSource } from './engine-auth.js'

const TEST_CREDENTIALS: EngineCredentialSource = { credentialFor: async () => ({ token: 'T'.repeat(43) }) }

const emptySlots = (): Fabric['slots'] => ({ stt: [], tts: [], llm: [], vlm: [], ocr: [], embed: [] })

const session = (over: Partial<Session> = {}): Session => ({
  id: 's1',
  workspaceId: 'default',
  modeId: 'mode-meeting',
  startedAt: '2026-07-07T00:00:00.000Z',
  attribution: { evidence: [], confidence: 1 },
  ...over,
})

/** A stub fetch that records calls and returns a canned JSON body. */
const stubFetch = (body: unknown, ok = true): { fetch: FetchLike; calls: Array<{ url: string; method: string | undefined; headers: Record<string, string> | undefined; body: string | undefined }> } => {
  const calls: Array<{ url: string; method: string | undefined; headers: Record<string, string> | undefined; body: string | undefined }> = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method, headers: init?.headers, body: init?.body })
    return { ok, status: ok ? 200 : 500, json: async () => body }
  }
  return { fetch, calls }
}

test('liveSession queries /sessions?live=true and returns the first', async () => {
  const { fetch, calls } = stubFetch([session()])
  const client = new EngineSessionClient('http://127.0.0.1:8787/', fetch, TEST_CREDENTIALS)
  const live = await client.liveSession('default')
  assert.equal(live?.id, 's1')
  assert.match(calls[0]!.url, /\/sessions\?workspace=default&live=true$/)
})

test('startSession POSTs a StartSessionRequest', async () => {
  const { fetch, calls } = stubFetch(session({ id: 's2' }))
  const client = new EngineSessionClient('http://127.0.0.1:8787', fetch, TEST_CREDENTIALS)
  const started = await client.startSession({ workspaceId: 'default', modeId: 'mode-meeting' })
  assert.equal(started.id, 's2')
  assert.equal(calls[0]!.method, 'POST')
  assert.equal(calls[0]!.url, 'http://127.0.0.1:8787/sessions')
  assert.deepEqual(JSON.parse(calls[0]!.body!), { workspaceId: 'default', modeId: 'mode-meeting' })
})

test('endSession POSTs to /sessions/:id/end', async () => {
  const { fetch, calls } = stubFetch(session({ endedAt: '2026-07-07T01:00:00.000Z' }))
  const client = new EngineSessionClient('http://127.0.0.1:8787', fetch, TEST_CREDENTIALS)
  await client.endSession('s1')
  assert.equal(calls[0]!.url, 'http://127.0.0.1:8787/sessions/s1/end')
  assert.equal(calls[0]!.method, 'POST')
  assert.equal(calls[0]!.headers?.['content-type'], 'application/json')
})

test('a non-ok response throws', async () => {
  const { fetch } = stubFetch({}, false)
  const client = new EngineSessionClient('http://127.0.0.1:8787', fetch, TEST_CREDENTIALS)
  await assert.rejects(() => client.liveSession('default'))
})

test('session requests carry a discovered bearer without putting it in the body or error', async () => {
  const token = 'S'.repeat(43)
  const credentials: EngineCredentialSource = { credentialFor: async () => ({ token }) }
  const { fetch, calls } = stubFetch(session())
  const client = new EngineSessionClient('http://127.0.0.1:8787', fetch, credentials)
  await client.startSession({ workspaceId: 'default', modeId: 'mode-meeting' })
  assert.equal(calls[0]!.headers?.['authorization'], `Bearer ${token}`)
  assert.equal(calls[0]!.headers?.['content-type'], 'application/json')
  assert.equal(calls[0]!.body?.includes(token), false)

  const failing: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}) })
  const rejected = new EngineSessionClient('http://127.0.0.1:8787', failing, credentials)
  await assert.rejects(
    () => rejected.liveSession('default'),
    (error: unknown) => error instanceof Error && !error.message.includes(token),
  )
})

test('session client reloads once on 401 and retries with the rotated bearer', async () => {
  const oldToken = 'O'.repeat(43)
  const newToken = 'N'.repeat(43)
  const refreshes: Array<boolean | undefined> = []
  const credentials: EngineCredentialSource = {
    credentialFor: async (_baseUrl, options) => {
      refreshes.push(options?.refresh)
      return { token: options?.refresh ? newToken : oldToken }
    },
  }
  const authorizations: Array<string | undefined> = []
  const fetch: FetchLike = async (_url, init) => {
    authorizations.push(init?.headers?.['authorization'])
    const status = authorizations.length === 1 ? 401 : 200
    return { ok: status === 200, status, json: async () => [session()] }
  }
  const client = new EngineSessionClient('http://127.0.0.1:8787', fetch, credentials)
  assert.equal((await client.liveSession('default'))?.id, 's1')
  assert.deepEqual(refreshes, [undefined, true])
  assert.deepEqual(authorizations, [`Bearer ${oldToken}`, `Bearer ${newToken}`])
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

test('#211 SessionLiveState tracks the episode title and refreshes on session.titled', () => {
  const state = new SessionLiveState('default')
  const changes: boolean[] = []
  state.onChange((live) => changes.push(live))

  state.applyEvent({ name: 'session.started', payload: session({ id: 's1' }) })
  assert.equal(state.liveSessionTitle, undefined, 'untitled at first')

  // a derived/user title lands mid-session — the tray label refreshes WITHOUT a liveness flip
  const changed = state.applyEvent({ name: 'session.titled', payload: session({ id: 's1', title: 'Meeting on Q3 launch' }) })
  assert.equal(changed, true, 'the change is signalled so the tray repaints')
  assert.equal(state.liveSessionTitle, 'Meeting on Q3 launch')
  assert.equal(state.live, true, 'still live')

  // a titled event for a DIFFERENT session is ignored
  state.applyEvent({ name: 'session.titled', payload: session({ id: 'sX', title: 'Someone else' }) })
  assert.equal(state.liveSessionTitle, 'Meeting on Q3 launch')

  // an identical retitle is a no-op (no needless repaint)
  assert.equal(state.applyEvent({ name: 'session.titled', payload: session({ id: 's1', title: 'Meeting on Q3 launch' }) }), false)

  // ending the session clears the title too
  state.applyEvent({ name: 'session.ended', payload: session({ id: 's1', endedAt: '2026-07-07T01:00:00.000Z' }) })
  assert.equal(state.liveSessionTitle, undefined)
})

test('fabric() GETs the live fabric', async () => {
  const fab: Fabric = { slots: emptySlots() }
  const { fetch, calls } = stubFetch(fab)
  const client = new EngineSessionClient('http://127.0.0.1:8787', fetch, TEST_CREDENTIALS)
  assert.deepEqual(await client.fabric(), fab)
  assert.equal(calls[0]!.url, 'http://127.0.0.1:8787/fabric')
  assert.equal(calls[0]!.method, 'GET')
})

test('needsModelSetup is true exactly when the llm slot is empty', () => {
  assert.equal(needsModelSetup({ slots: emptySlots() }), true)
  const withLlm: Fabric = { slots: { ...emptySlots(), llm: [{ kind: 'http', name: 'l', url: 'http://x', api: 'openai-compat' }] } }
  assert.equal(needsModelSetup(withLlm), false)
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
