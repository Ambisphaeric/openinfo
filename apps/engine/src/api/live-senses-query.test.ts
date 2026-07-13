import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SenseLaneSnapshot as SenseLaneSnapshotSchema,
  type CaptureChunk,
  type QueryResult,
  type SenseLaneSnapshot,
  type Session,
  type Surface,
} from '@openinfo/contracts'
import { Value } from '@sinclair/typebox/value'
import { createSecureTestEngineApp, secureTestFetch } from './test-control-plane.js'

const listen = async (app: ReturnType<typeof createSecureTestEngineApp>): Promise<string> => {
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  const address = app.server.address()
  assert.ok(address && typeof address === 'object')
  return `http://127.0.0.1:${address.port}`
}

const json = async <T>(url: string, body: unknown): Promise<{ response: Response; body: T }> => {
  const response = await secureTestFetch(url, { method: 'POST', body: JSON.stringify(body) })
  return { response, body: await response.json() as T }
}

const startSession = async (base: string, workspaceId: string): Promise<Session> => {
  const started = await json<Session>(`${base}/sessions`, { workspaceId, modeId: 'mode-meeting' })
  assert.equal(started.response.status, 200)
  return started.body
}

const capture = async (
  base: string,
  session: Session,
  source: 'mic' | 'system-audio',
  id: string,
  data: string,
): Promise<void> => {
  const chunk: CaptureChunk = {
    id,
    sessionId: session.id,
    workspaceId: session.workspaceId,
    source,
    sequence: 1,
    capturedAt: new Date().toISOString(),
    contentType: source === 'mic' ? 'audio/webm' : 'audio/wav',
    encoding: 'base64',
    data,
  }
  const response = await secureTestFetch(`${base}/capture/${source}`, { method: 'POST', body: JSON.stringify(chunk) })
  assert.equal(response.status, 200)
}

const putSurface = async (base: string, surface: Surface): Promise<void> => {
  const response = await secureTestFetch(`${base}/layouts/surfaces/${surface.id}`, {
    method: 'PUT',
    body: JSON.stringify(surface),
  })
  assert.equal(response.status, 200)
}

const query = async (base: string, surfaceId: string, body: unknown): Promise<QueryResult> => {
  const result = await json<QueryResult>(`${base}/query?surface=${encodeURIComponent(surfaceId)}`, body)
  assert.equal(result.response.status, 200)
  return result.body
}

test('POST /query live-senses is authenticated, instance-scoped, explicit-scope aware, and metadata-only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-live-senses-query-'))
  const app = createSecureTestEngineApp({ dataRoot: dir, log: () => undefined })
  const base = await listen(app)
  try {
    // /query remains inside the ordinary control-plane boundary; the new source does not introduce a
    // side route or auth exception.
    const unauthenticated = await globalThis.fetch(`${base}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'live-senses', params: { session: 'current' }, top: 3 }),
    })
    assert.equal(unauthenticated.status, 401)

    const sessionA = await startSession(base, 'ws-live-a')
    const sessionB = await startSession(base, 'ws-live-b')
    const privateMic = 'UFJJVkFURV9NSUNfQllURVM='
    const privateSystem = 'UFJJVkFURV9TWVNURU1fQllURVM='
    await capture(base, sessionA, 'mic', 'mic-private-1', privateMic)
    await capture(base, sessionB, 'system-audio', 'system-private-1', privateSystem)

    const surface: Surface = {
      id: 'surf-live-senses-a',
      name: 'Workspace A capture truth',
      context: 'meeting',
      workspaceId: 'ws-live-a',
      version: 1,
      stack: [{
        block: 'sense-lanes',
        show: 'always',
        top: 3,
        query: { source: 'live-senses', params: { session: 'current' }, top: 3 },
      }],
    }
    await putSurface(base, surface)

    // No params.workspace: the AppInstance binding owns the scope. The process-local current session is
    // selected, and the tracker supplies its canonical lane order.
    const bound = await query(base, surface.id, surface.stack[0]!.query)
    const boundRows = bound.items as SenseLaneSnapshot[]
    assert.equal(bound.source, 'live-senses')
    assert.deepEqual(boundRows.map((row) => row.source), ['mic', 'system-audio', 'screen'])
    assert.ok(boundRows.every((row) => row.workspaceId === 'ws-live-a' && row.sessionId === sessionA.id))
    assert.equal(boundRows[0]!.latestCapture?.id, 'mic-private-1')
    assert.equal(boundRows[1]!.latestCapture, undefined, 'workspace B system audio cannot cross the binding')
    assert.equal(bound.truncated, false)

    // An explicit per-block workspace remains authoritative over the AppInstance binding.
    const explicitWorkspace = await query(base, surface.id, {
      source: 'live-senses',
      params: { workspace: 'ws-live-b', session: 'current' },
      top: 3,
    })
    const workspaceBRows = explicitWorkspace.items as SenseLaneSnapshot[]
    assert.ok(workspaceBRows.every((row) => row.workspaceId === 'ws-live-b' && row.sessionId === sessionB.id))
    assert.equal(workspaceBRows[0]!.latestCapture, undefined)
    assert.equal(workspaceBRows[1]!.latestCapture?.id, 'system-private-1')

    // A concrete session id never borrows the workspace current. An unknown process-local scope is three
    // explicit stopped rows, which is safer and more honest than reading another session's state.
    const explicitSession = await query(base, surface.id, {
      source: 'live-senses',
      params: { session: 'not-observed-this-launch' },
      top: 3,
    })
    const explicitRows = explicitSession.items as SenseLaneSnapshot[]
    assert.deepEqual(explicitRows.map((row) => row.source), ['mic', 'system-audio', 'screen'])
    assert.ok(explicitRows.every((row) =>
      row.workspaceId === 'ws-live-a' &&
      row.sessionId === 'not-observed-this-launch' &&
      row.disposition === 'stopped' &&
      row.reason === 'no-session'
    ))

    // The query payload is structurally the existing closed metadata contract. Private capture bytes and
    // content-channel fields cannot egress through this composable HUD source.
    for (const row of [...boundRows, ...workspaceBRows, ...explicitRows]) {
      assert.equal(Value.Check(SenseLaneSnapshotSchema, row), true)
    }
    const serialized = JSON.stringify([bound, explicitWorkspace, explicitSession])
    assert.doesNotMatch(serialized, new RegExp(privateMic))
    assert.doesNotMatch(serialized, new RegExp(privateSystem))
    for (const forbidden of ['"data"', '"text"', '"pixels"', '"transcript"', '"ocr"', '"endpoint"', '"error"']) {
      assert.equal(serialized.includes(forbidden), false, `live-senses leaked forbidden field ${forbidden}`)
    }
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('live-senses session=current never resurrects a persisted session the tracker did not observe', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-live-senses-query-cold-'))
  const app = createSecureTestEngineApp({ dataRoot: dir, log: () => undefined })
  const base = await listen(app)
  try {
    const stale: Session = {
      id: 'persisted-only-session',
      workspaceId: 'ws-cold-process',
      modeId: 'mode-meeting',
      startedAt: '2026-07-13T12:00:00.000Z',
      attribution: { evidence: [], confidence: 1 },
    }
    app.store.saveSession(stale)

    const result = await query(base, 'no-bound-surface', {
      source: 'live-senses',
      params: { workspace: stale.workspaceId, session: 'current' },
      top: 3,
    })
    const rows = result.items as SenseLaneSnapshot[]
    assert.deepEqual(rows.map((row) => row.source), ['mic', 'system-audio', 'screen'])
    assert.ok(rows.every((row) =>
      row.workspaceId === stale.workspaceId &&
      row.sessionId === undefined &&
      row.disposition === 'stopped' &&
      row.reason === 'no-session'
    ))
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})
