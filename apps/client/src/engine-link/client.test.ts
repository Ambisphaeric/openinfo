import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { EngineCredentialSource, EngineFetchLike } from '../main/engine-auth.js'
import { EngineLink } from './client.js'

const TOKEN_A = 'A'.repeat(43)
const TOKEN_B = 'B'.repeat(43)

const withLink = async (
  options: Omit<ConstructorParameters<typeof EngineLink>[0], 'spoolDir'>,
  run: (link: EngineLink) => Promise<void>,
): Promise<void> => {
  const spoolDir = await mkdtemp(path.join(tmpdir(), 'openinfo-engine-link-auth-'))
  try {
    await run(new EngineLink({ ...options, spoolDir }))
  } finally {
    await rm(spoolDir, { recursive: true, force: true })
  }
}

test('EngineLink HTTP requests inject Bearer and reload exactly once on 401', async () => {
  const refreshes: Array<boolean | undefined> = []
  const credentials: EngineCredentialSource = {
    credentialFor: async (_baseUrl, options) => {
      refreshes.push(options?.refresh)
      return { token: options?.refresh ? TOKEN_B : TOKEN_A }
    },
  }
  const authorizations: Array<string | undefined> = []
  const fetchImpl: EngineFetchLike = async (_url, init) => {
    authorizations.push(init?.headers?.['authorization'])
    const status = authorizations.length === 1 ? 401 : 200
    return { ok: status === 200, status, json: async () => ({ version: '0.0.17' }) }
  }

  await withLink({ baseUrl: 'http://127.0.0.1:8787', credentials, fetchImpl }, async (link) => {
    assert.equal((await link.health()).version, '0.0.17')
  })
  assert.deepEqual(refreshes, [undefined, true])
  assert.deepEqual(authorizations, [`Bearer ${TOKEN_A}`, `Bearer ${TOKEN_B}`])
})

test('EngineLink bodyless mutations still declare JSON at the secured boundary', async () => {
  const calls: Array<{ method?: string; headers?: Record<string, string>; body?: string }> = []
  await withLink({
    baseUrl: 'http://127.0.0.1:8787',
    credentials: { credentialFor: async () => ({ token: TOKEN_A }) },
    fetchImpl: async (_url, init) => {
      calls.push(init ?? {})
      return { ok: true, status: 200, json: async () => ({ id: 's1' }) }
    },
  }, async (link) => {
    await link.endSession('s1')
  })
  assert.equal(calls[0]?.method, 'POST')
  assert.equal(calls[0]?.headers?.['content-type'], 'application/json')
  assert.equal(calls[0]?.body, undefined)
})

test('screen observations use Bearer auth, exact JSON, and the shared one-refresh-on-401 path', async () => {
  const refreshes: Array<boolean | undefined> = []
  const credentials: EngineCredentialSource = {
    credentialFor: async (_baseUrl, options) => {
      refreshes.push(options?.refresh)
      return { token: options?.refresh ? TOKEN_B : TOKEN_A }
    },
  }
  const calls: Array<{ url: string; method?: string; headers?: Record<string, string>; body?: string }> = []
  const fetchImpl: EngineFetchLike = async (url, init) => {
    calls.push({ url, ...init })
    const status = calls.length === 1 ? 401 : 200
    return {
      ok: status === 200,
      status,
      json: async () => ({
        workspaceId: 'ws',
        sessionId: 'session-1',
        source: 'screen',
        disposition: 'delta-skipped',
        health: 'healthy',
        reason: 'delta-skipped',
        updatedAt: '2026-07-13T10:11:12.345Z',
      }),
    }
  }
  const observation = {
    workspaceId: 'ws',
    sessionId: 'session-1',
    outcome: 'delta-skipped' as const,
    observationId: 'observation-1',
    occurredAt: '2026-07-13T10:11:12.345Z',
  }

  await withLink({ baseUrl: 'http://127.0.0.1:8787', credentials, fetchImpl }, async (link) => {
    assert.equal((await link.observeScreen(observation))?.source, 'screen')
  })
  assert.deepEqual(refreshes, [undefined, true])
  assert.equal(calls[0]?.url, 'http://127.0.0.1:8787/screen/observations')
  assert.equal(calls[0]?.method, 'POST')
  assert.equal(calls[0]?.headers?.['content-type'], 'application/json')
  assert.equal(calls[0]?.headers?.['authorization'], `Bearer ${TOKEN_A}`)
  assert.equal(calls[1]?.headers?.['authorization'], `Bearer ${TOKEN_B}`)
  assert.deepEqual(JSON.parse(calls[0]?.body ?? '{}'), observation)
})

test('failed screen observation reports are dropped and never enter the capture spool', async () => {
  await withLink({
    baseUrl: 'http://127.0.0.1:8787',
    credentials: { credentialFor: async () => ({ token: TOKEN_A }) },
    fetchImpl: async () => {
      throw new Error('offline')
    },
  }, async (link) => {
    const result = await link.observeScreen({
      workspaceId: 'ws',
      sessionId: 'session-1',
      outcome: 'grab-failed',
      observationId: 'observation-1',
      occurredAt: '2026-07-13T10:11:12.345Z',
    })
    assert.equal(result, undefined)
    assert.equal(await link.spool.pendingCount(), 0)
  })
})

test('screen observations replace an older in-flight report instead of accumulating requests', async () => {
  let inFlight = 0
  let maxInFlight = 0
  const started: string[] = []
  const aborted: string[] = []
  const fetchImpl: EngineFetchLike = async (_url, init) => {
    const observationId = (JSON.parse(init?.body ?? '{}') as { observationId?: string }).observationId ?? 'unknown'
    started.push(observationId)
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)

    if (observationId === 'observation-2') {
      inFlight -= 1
      return {
        ok: true,
        status: 200,
        json: async () => ({
          workspaceId: 'ws',
          sessionId: 'session-1',
          source: 'screen',
          disposition: 'delta-skipped',
          health: 'healthy',
          reason: 'delta-skipped',
          updatedAt: '2026-07-13T10:11:13.345Z',
        }),
      }
    }

    return new Promise((_resolve, reject) => {
      const onAbort = (): void => {
        inFlight -= 1
        aborted.push(observationId)
        reject(new Error('aborted'))
      }
      if (init?.signal?.aborted) onAbort()
      else init?.signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  await withLink({
    baseUrl: 'http://127.0.0.1:8787',
    credentials: { credentialFor: async () => ({ token: TOKEN_A }) },
    fetchImpl,
    screenObservationTimeoutMs: 60_000,
  }, async (link) => {
    const first = link.observeScreen({
      workspaceId: 'ws',
      sessionId: 'session-1',
      outcome: 'delta-skipped',
      observationId: 'observation-1',
      occurredAt: '2026-07-13T10:11:12.345Z',
    })
    await turn()

    const second = link.observeScreen({
      workspaceId: 'ws',
      sessionId: 'session-1',
      outcome: 'delta-skipped',
      observationId: 'observation-2',
      occurredAt: '2026-07-13T10:11:13.345Z',
    })

    const [firstResult, secondResult] = await Promise.all([first, second])
    assert.equal(firstResult, undefined, 'the superseded request settles harmlessly')
    assert.equal(secondResult?.source, 'screen', 'the latest observation reaches the engine')
    assert.deepEqual(started, ['observation-1', 'observation-2'])
    assert.deepEqual(aborted, ['observation-1'])
    assert.equal(maxInFlight, 1)
    assert.equal(inFlight, 0)
    assert.equal(await link.spool.pendingCount(), 0)
  })
})

test('the latest screen observation times out harmlessly when fetch never answers', async () => {
  let aborted = false
  const fetchImpl: EngineFetchLike = async (_url, init) => new Promise((_resolve, reject) => {
    const onAbort = (): void => {
      aborted = true
      reject(new Error('aborted'))
    }
    if (init?.signal?.aborted) onAbort()
    else init?.signal?.addEventListener('abort', onAbort, { once: true })
  })

  await withLink({
    baseUrl: 'http://127.0.0.1:8787',
    credentials: { credentialFor: async () => ({ token: TOKEN_A }) },
    fetchImpl,
    screenObservationTimeoutMs: 5,
  }, async (link) => {
    const result = await link.observeScreen({
      workspaceId: 'ws',
      sessionId: 'session-1',
      outcome: 'grab-failed',
      observationId: 'observation-timeout',
      occurredAt: '2026-07-13T10:11:12.345Z',
    })
    assert.equal(result, undefined)
    assert.equal(aborted, true)
    assert.equal(await link.spool.pendingCount(), 0)
  })
})

type Listener = (event: { data?: unknown }) => void

class FakeSocket {
  private readonly listeners = new Map<string, Listener[]>()
  closed = false

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callback: Listener = typeof listener === 'function'
      ? (event) => listener(event as unknown as Event)
      : (event) => listener.handleEvent(event as unknown as Event)
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback])
  }

  emit(type: string, event: { data?: unknown } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }
}

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

test('EngineLink WS uses exact auth protocols and reloads credentials before reconnect', async () => {
  const loads: Array<boolean | undefined> = []
  const credentials: EngineCredentialSource = {
    credentialFor: async (_baseUrl, options) => {
      loads.push(options?.refresh)
      return { token: loads.length === 1 ? TOKEN_A : TOKEN_B }
    },
  }
  const sockets: FakeSocket[] = []
  const opens: Array<{ url: string; protocols: string[] | undefined }> = []
  const scheduled: Array<() => void> = []

  await withLink({
    baseUrl: 'http://127.0.0.1:8787',
    credentials,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    webSocketFactory: (url, protocols) => {
      opens.push({ url, protocols })
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket as unknown as WebSocket
    },
    scheduleReconnect: (callback) => scheduled.push(callback),
  }, async (link) => {
    const events: string[] = []
    const unsubscribe = link.subscribe((event) => events.push(event.name))
    await turn()
    assert.deepEqual(loads, [true])
    assert.deepEqual(opens[0], {
      url: 'ws://127.0.0.1:8787/events',
      protocols: ['openinfo.v1', `openinfo.auth.${TOKEN_A}`],
    })
    assert.equal(opens[0]!.protocols?.includes(TOKEN_A), false)

    sockets[0]!.emit('open')
    sockets[0]!.emit('message', { data: JSON.stringify({ name: 'session.started', payload: { id: 's1' } }) })
    assert.deepEqual(events, ['ws.open', 'session.started'])

    sockets[0]!.emit('close')
    assert.equal(scheduled.length, 1)
    scheduled.shift()!()
    await turn()
    assert.deepEqual(loads, [true, true])
    assert.deepEqual(opens[1]?.protocols, ['openinfo.v1', `openinfo.auth.${TOKEN_B}`])

    unsubscribe()
    assert.equal(sockets[1]!.closed, true)
    assert.equal(scheduled.length, 0, 'unsubscribe must not schedule another reconnect')
  })
})

test('EngineLink fails closed and never opens WS when no credential exists', async () => {
  let opened = false
  const scheduled: Array<() => void> = []
  await withLink({
    baseUrl: 'http://127.0.0.1:8787',
    credentials: { credentialFor: async () => undefined },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    webSocketFactory: () => {
      opened = true
      return new FakeSocket() as unknown as WebSocket
    },
    scheduleReconnect: (callback) => scheduled.push(callback),
  }, async (link) => {
    const unsubscribe = link.subscribe(() => undefined)
    await turn()
    assert.equal(opened, false)
    assert.equal(scheduled.length, 1)
    unsubscribe()
  })
})
