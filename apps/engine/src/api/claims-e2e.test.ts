import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Claim as ClaimSchema, type Claim, type RelatedEntity, type Session } from '@openinfo/contracts'
import { Value } from '@sinclair/typebox/value'
import { createSecureTestEngineApp, secureTestFetch, TEST_CONTROL_TOKEN } from './test-control-plane.js'

const listen = async (app: ReturnType<typeof createSecureTestEngineApp>): Promise<string> => {
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  const address = app.server.address()
  assert.ok(address && typeof address === 'object')
  return `http://127.0.0.1:${address.port}`
}

const WS = 'ws-claims-api'

test('#178: /claims is authenticated, builds idempotently, answers the query axes, walks relations, and honors sovereign corrections', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-claims-api-'))
  const app = createSecureTestEngineApp({ dataRoot: dir, log: () => undefined })
  const base = await listen(app)
  try {
    // Auth: every claims route lives inside the ordinary control-plane boundary — no side door.
    assert.equal((await globalThis.fetch(`${base}/claims`)).status, 401, 'unauthenticated read refused')
    assert.equal((await globalThis.fetch(`${base}/claims/related?entity=x`)).status, 401, 'unauthenticated walk refused')
    const unauthBuild = await globalThis.fetch(`${base}/claims/build`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: WS, sessionId: 'x' }),
    })
    assert.equal(unauthBuild.status, 401, 'unauthenticated build refused')
    assert.equal(
      (await globalThis.fetch(`${base}/claims`, { headers: { authorization: `Bearer ${TEST_CONTROL_TOKEN.slice(0, -1)}x` } })).status,
      401,
      'a wrong bearer is refused',
    )

    // A session with two entities co-mentioned in one moment — the minimal co-occurrence evidence.
    const started = await secureTestFetch(`${base}/sessions`, { method: 'POST', body: JSON.stringify({ workspaceId: WS, modeId: 'mode-meeting' }) })
    assert.equal(started.status, 200)
    const session = (await started.json()) as Session
    const ada = app.store.upsertEntity({ workspaceId: WS, kind: 'person', name: 'Ada', seenAt: '2026-07-12T13:00:00.000Z' })
    const pidev = app.store.upsertEntity({ workspaceId: WS, kind: 'artifact', name: 'pi.dev', seenAt: '2026-07-12T13:00:00.000Z' })
    app.store.saveMoment({
      id: 'mom-1', sessionId: session.id, workspaceId: WS, at: '2026-07-12T13:00:01.000Z', kind: 'mention',
      text: 'Ada is working on pi.dev', refs: [ada.id, pidev.id], source: 'mic', confidence: 0.9,
    })

    // Honest caller errors on the build route.
    assert.equal((await secureTestFetch(`${base}/claims/build`, { method: 'POST', body: JSON.stringify({ workspaceId: WS }) })).status, 400)
    assert.equal(
      (await secureTestFetch(`${base}/claims/build`, { method: 'POST', body: JSON.stringify({ workspaceId: 'never-made', sessionId: session.id }) })).status,
      404,
    )
    assert.equal(
      (await secureTestFetch(`${base}/claims/build`, { method: 'POST', body: JSON.stringify({ workspaceId: WS, sessionId: 'no-such' }) })).status,
      404,
    )

    // Build: one co-occurrence claim; it validates and is a provisional derived proposal.
    const build = await secureTestFetch(`${base}/claims/build`, { method: 'POST', body: JSON.stringify({ workspaceId: WS, sessionId: session.id }) })
    assert.equal(build.status, 200)
    const created = (await build.json()) as Claim[]
    assert.equal(created.length, 1)
    const claim = created[0]!
    assert.deepEqual([...Value.Errors(ClaimSchema, claim)], [], 'the served claim validates')
    assert.equal(claim.relation, 'co-occurs-with')
    assert.equal(claim.source, 'derived')
    assert.equal(claim.state, 'provisional')
    assert.ok(claim.evidence.length >= 1, 'every served claim is evidence-backed')

    // Idempotent: an immediate rebuild appends nothing — the honest empty array.
    const rebuild = await secureTestFetch(`${base}/claims/build`, { method: 'POST', body: JSON.stringify({ workspaceId: WS, sessionId: session.id }) })
    assert.deepEqual(await rebuild.json(), [], 'nothing changed, nothing appended')

    // Query axes over the served route.
    const read = async (query: string): Promise<Claim[]> => {
      const response = await secureTestFetch(`${base}/claims?workspace=${WS}${query}`)
      assert.equal(response.status, 200)
      return (await response.json()) as Claim[]
    }
    assert.deepEqual((await read('')).map((c) => c.id), [claim.id], 'default read = live head')
    assert.deepEqual((await read(`&entity=${ada.id}`)).map((c) => c.id), [claim.id], 'entity axis (subject or object)')
    assert.deepEqual((await read('&relation=works-on')), [], 'relation axis filters')
    assert.deepEqual(await read('&entity=ent-nobody'), [], 'an unrelated entity walks to nothing')
    assert.deepEqual(await (await secureTestFetch(`${base}/claims?workspace=never-made`)).json(), [], 'unknown workspace reads []')

    // The depth-1 relationship walk: Ada → pi.dev, carrying the backing claim id.
    const walkRes = await secureTestFetch(`${base}/claims/related?workspace=${WS}&entity=${ada.id}`)
    assert.equal(walkRes.status, 200)
    const walk = (await walkRes.json()) as RelatedEntity[]
    assert.equal(walk.length, 1)
    assert.equal(walk[0]!.entityId, pidev.id)
    assert.equal(walk[0]!.name, 'pi.dev')
    assert.deepEqual(walk[0]!.claimIds, [claim.id], 'the walk always returns the supporting claim')
    assert.equal((await secureTestFetch(`${base}/claims/related?workspace=${WS}`)).status, 400, 'the walk needs an ?entity=')

    // Sovereign user correction: confirm outranks the derived claim as the live head.
    const correctRes = await secureTestFetch(`${base}/claims/correct`, {
      method: 'POST', body: JSON.stringify({ workspaceId: WS, claimId: claim.id, verdict: 'confirm', by: 'the user' }),
    })
    assert.equal(correctRes.status, 200)
    const correction = (await correctRes.json()) as Claim
    assert.equal(correction.source, 'user')
    assert.equal(correction.state, 'confirmed')
    assert.deepEqual((await read('')).map((c) => `${c.source}:${c.state}`), ['user:confirmed'], 'the sovereign confirmation is the live head')
    assert.equal((await read('&superseded=true')).length, 2, 'the original derived inference is retained, never deleted')

    // Correcting an unknown claim is an honest 404.
    assert.equal(
      (await secureTestFetch(`${base}/claims/correct`, { method: 'POST', body: JSON.stringify({ workspaceId: WS, claimId: 'clm-nope', verdict: 'reject' }) })).status,
      404,
    )
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})
