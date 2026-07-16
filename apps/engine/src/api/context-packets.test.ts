import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ContextPacket as ContextPacketSchema, type ContextPacket, type Session } from '@openinfo/contracts'
import { Value } from '@sinclair/typebox/value'
import { createSecureTestEngineApp, secureTestFetch, TEST_CONTROL_TOKEN } from './test-control-plane.js'

const listen = async (app: ReturnType<typeof createSecureTestEngineApp>): Promise<string> => {
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  const address = app.server.address()
  assert.ok(address && typeof address === 'object')
  return `http://127.0.0.1:${address.port}`
}

const WS = 'ws-packets-api'

const seedObservations = (app: ReturnType<typeof createSecureTestEngineApp>, session: Session): void => {
  app.store.saveSttSegment({
    id: 'stt-mic-1', workspaceId: WS, sessionId: session.id, chunkId: 'cap-mic-1', source: 'mic',
    capturedAt: '2026-07-12T13:00:00.000Z', processedAt: '2026-07-12T13:00:01.000Z', textChars: 40,
    provenance: { slot: 'stt', endpoint: 'fixture-parakeet' }, schemaVersion: 1, createdAt: '2026-07-12T13:00:01.000Z',
  })
  app.store.saveSttSegment({
    id: 'stt-sys-1', workspaceId: WS, sessionId: session.id, chunkId: 'cap-sys-1', source: 'system-audio',
    capturedAt: '2026-07-12T13:00:01.000Z', processedAt: '2026-07-12T13:00:02.000Z', textChars: 35,
    provenance: { slot: 'stt', endpoint: 'fixture-parakeet' }, schemaVersion: 1, createdAt: '2026-07-12T13:00:02.000Z',
  })
}

test('#176: /context/packets is authenticated, builds idempotently, supersedes append-only, and answers every query axis', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-packets-api-'))
  const app = createSecureTestEngineApp({ dataRoot: dir, log: () => undefined })
  const base = await listen(app)
  try {
    // Auth: both routes live inside the ordinary control-plane boundary — no side door.
    const unauthRead = await globalThis.fetch(`${base}/context/packets`)
    assert.equal(unauthRead.status, 401, 'unauthenticated read is refused')
    const unauthBuild = await globalThis.fetch(`${base}/context/packets/build`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: WS, sessionId: 'x' }),
    })
    assert.equal(unauthBuild.status, 401, 'unauthenticated build is refused')
    const wrongToken = await globalThis.fetch(`${base}/context/packets`, {
      headers: { authorization: `Bearer ${TEST_CONTROL_TOKEN.slice(0, -1)}x` },
    })
    assert.equal(wrongToken.status, 401, 'a wrong bearer is refused')

    // A session with two audio-lane observations (the screen arrives late, below).
    const started = await secureTestFetch(`${base}/sessions`, {
      method: 'POST',
      body: JSON.stringify({ workspaceId: WS, modeId: 'mode-meeting' }),
    })
    assert.equal(started.status, 200)
    const session = (await started.json()) as Session
    seedObservations(app, session)

    // Honest caller errors: malformed body, unknown workspace, unknown session.
    const malformed = await secureTestFetch(`${base}/context/packets/build`, { method: 'POST', body: JSON.stringify({ workspaceId: WS }) })
    assert.equal(malformed.status, 400)
    const noWs = await secureTestFetch(`${base}/context/packets/build`, {
      method: 'POST',
      body: JSON.stringify({ workspaceId: 'never-made', sessionId: session.id }),
    })
    assert.equal(noWs.status, 404)
    const noSession = await secureTestFetch(`${base}/context/packets/build`, {
      method: 'POST',
      body: JSON.stringify({ workspaceId: WS, sessionId: 'no-such-session' }),
    })
    assert.equal(noSession.status, 404)

    // Build: one partial packet (mic + system-audio, screen honestly missing).
    const build = await secureTestFetch(`${base}/context/packets/build`, {
      method: 'POST',
      body: JSON.stringify({ workspaceId: WS, sessionId: session.id }),
    })
    assert.equal(build.status, 200)
    const created = (await build.json()) as ContextPacket[]
    assert.equal(created.length, 1)
    const v1 = created[0]!
    assert.deepEqual([...Value.Errors(ContextPacketSchema, v1)], [], 'the served packet validates')
    assert.equal(v1.revision, 1)
    assert.deepEqual(v1.microphone.map((r) => r.id), ['stt-mic-1'])
    assert.deepEqual(v1.systemAudio.map((r) => r.id), ['stt-sys-1'])
    assert.deepEqual(v1.gaps, [{ lane: 'screen', reason: 'no-observations-this-session' }])

    // Idempotent: an immediate rebuild appends nothing — the honest empty array.
    const rebuild = await secureTestFetch(`${base}/context/packets/build`, {
      method: 'POST',
      body: JSON.stringify({ workspaceId: WS, sessionId: session.id }),
    })
    assert.deepEqual(await rebuild.json(), [], 'nothing changed, nothing appended')

    // A late screen observation supersedes append-only: revision 2 links back, v1 stays retrievable.
    app.store.saveOcrResult({
      id: 'ocr-late', sessionId: session.id, workspaceId: WS, sourceChunks: ['cap-scr-1'],
      text: 'Pull request 150 — checks passing', provenance: { slot: 'ocr', endpoint: 'fixture-ocr' },
      schemaVersion: 1, createdAt: '2026-07-12T13:00:03.000Z', capturedAt: '2026-07-12T13:00:02.000Z',
    })
    const lateBuild = await secureTestFetch(`${base}/context/packets/build`, {
      method: 'POST',
      body: JSON.stringify({ workspaceId: WS, sessionId: session.id }),
    })
    const [v2] = (await lateBuild.json()) as ContextPacket[]
    assert.ok(v2)
    assert.equal(v2.revision, 2)
    assert.equal(v2.supersedes, v1.id)
    assert.deepEqual(v2.screen.map((r) => r.id), ['ocr-late'])
    assert.deepEqual(v2.gaps, [], 'all senses present in the revision')

    // Query axes over the served route. Default: the live chain head only.
    const readJson = async (query: string): Promise<ContextPacket[]> => {
      const response = await secureTestFetch(`${base}/context/packets?workspace=${WS}${query}`)
      assert.equal(response.status, 200)
      return (await response.json()) as ContextPacket[]
    }
    assert.deepEqual((await readJson('')).map((p) => p.id), [v2.id], 'default read = live head')
    assert.deepEqual((await readJson('&superseded=true')).map((p) => p.id).sort(), [v1.id, v2.id].sort(), 'history on request')
    assert.deepEqual((await readJson(`&session=${session.id}`)).map((p) => p.id), [v2.id], 'session axis')
    assert.deepEqual((await readJson('&session=no-such-session')), [], 'unknown session reads empty, not an error')
    assert.deepEqual(
      (await readJson('&from=2026-07-12T13:00:30.000Z&to=2026-07-12T13:00:45.000Z')).map((p) => p.id),
      [v2.id],
      'time axis: window intersection',
    )
    assert.deepEqual(await readJson('&from=2026-07-12T14:00:00.000Z'), [], 'a later range excludes the window')
    // Unknown workspace reads as [] (mirrors /moments), and the entity axis filters on candidates.
    const unknownWs = await secureTestFetch(`${base}/context/packets?workspace=never-made`)
    assert.deepEqual(await unknownWs.json(), [])
    assert.deepEqual(await readJson('&entity=ent-nobody'), [], 'no candidate names it')
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})
