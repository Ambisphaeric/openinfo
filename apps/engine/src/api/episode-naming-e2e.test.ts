import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Session, SessionTitling } from '@openinfo/contracts'
import { SESSION_TITLING_SCHEMA_VERSION } from '@openinfo/contracts'
import { createSecureTestEngineApp as createEngineApp, secureTestFetch as fetch } from './test-control-plane.js'

/** Boot a real engine over the real HTTP handlers; drive the episode-naming surfaces end to end. */
const withEngine = async (fn: (base: string, app: ReturnType<typeof createEngineApp>) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-episode-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    await fn(`http://127.0.0.1:${address.port}`, app)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
}

const startSession = async (base: string, body: Record<string, unknown>): Promise<Session> =>
  (await (await fetch(`${base}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()) as Session

const liveTitle = async (base: string, workspace = 'default'): Promise<string | undefined> => {
  const sessions = (await (await fetch(`${base}/sessions?workspace=${workspace}`)).json()) as Session[]
  return sessions[0]?.title
}

test('#211 PUT /sessions/:id/title renames a session; GET /sessions shows the materialised title', async () => {
  await withEngine(async (base) => {
    const session = await startSession(base, { workspaceId: 'default', modeId: 'mode-meeting' })
    assert.equal(session.title, undefined, 'an auto-started session carries no up-front title')

    const res = await fetch(`${base}/sessions/${session.id}/title`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Priya kickoff' }),
    })
    assert.equal(res.status, 200)
    assert.equal(((await res.json()) as Session).title, 'Priya kickoff')
    assert.equal(await liveTitle(base), 'Priya kickoff', 'the served session now carries the name')
  })
})

test('#211 PUT /sessions/:id/title emits session.titled so surfaces refresh in place', async () => {
  await withEngine(async (base, app) => {
    const titled: Session[] = []
    app.bus.subscribe('session.titled', (s) => void titled.push(s))
    const session = await startSession(base, { workspaceId: 'default', modeId: 'mode-meeting' })
    await fetch(`${base}/sessions/${session.id}/title`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Design review' }),
    })
    assert.equal(titled.length, 1, 'session.titled published')
    assert.equal(titled[0]!.title, 'Design review')
  })
})

test('#211 rename validation: unknown id ⇒ 404, blank/invalid body ⇒ 400', async () => {
  await withEngine(async (base) => {
    const notFound = await fetch(`${base}/sessions/nope/title`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })
    assert.equal(notFound.status, 404)
    const session = await startSession(base, { workspaceId: 'default', modeId: 'mode-meeting' })
    const blank = await fetch(`${base}/sessions/${session.id}/title`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '   ' }),
    })
    assert.equal(blank.status, 400, 'a blank title is not a name')
    const missing = await fetch(`${base}/sessions/${session.id}/title`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(missing.status, 400)
  })
})

test('#211 a caller-supplied start title is a SOVEREIGN user title: a later derived pass never clobbers it', async () => {
  await withEngine(async (base, app) => {
    const session = await startSession(base, { workspaceId: 'default', modeId: 'mode-meeting', title: 'Board sync' })
    assert.equal(await liveTitle(base), 'Board sync')

    // Simulate what the orientation pass does later: append a DERIVED titling through the real store.
    const derived: SessionTitling = {
      id: `ot:default:${session.id}:d1`,
      workspaceId: 'default',
      sessionId: session.id,
      title: 'Meeting on pricing',
      source: 'derived',
      provenance: {
        annotationId: `oa:default:${session.id}`,
        templateId: 'tpl-judge-orientation',
        endpoint: 'llm.judge',
        classifiedAt: '2026-07-10T12:00:00.000Z',
        nature: 'meeting',
        direction: 'learn',
        topics: ['pricing'],
      },
      createdAt: '2026-07-10T12:00:00.000Z',
      schemaVersion: SESSION_TITLING_SCHEMA_VERSION,
    }
    app.store.recordSessionTitling(derived)

    assert.equal(await liveTitle(base), 'Board sync', 'the user name stays sovereign over the derivation')
    assert.equal(app.store.listSessionTitlings('default', session.id).length, 2, 'both titlings retained (append-only)')
  })
})
