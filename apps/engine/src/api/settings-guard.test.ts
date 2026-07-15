import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Distillate, GuardHold } from '@openinfo/contracts'
import { createSecureTestEngineApp as createEngineApp, secureTestFetch as fetch } from './test-control-plane.js'

/**
 * DRIVEN served test for the egress-guard audit surfaces (#63), per the QA rule: it boots the engine,
 * seeds (a) a distillate whose provenance carries a REDACTED guard verdict and (b) a held GuardHold, then
 * GETs the SERVED /settings/ledger HTML and asserts the guard COLUMN lights up + the held block renders
 * with a release/deny affordance — and drives the POST /guard-holds/resolve action, confirming the status
 * flips (and never a silent blank/500). No raw flagged value is ever rendered — only span-kind descriptors.
 */

const seedRedactedPass = (): Distillate => ({
  id: 'dst-guarded',
  sessionId: 'ses-guard',
  workspaceId: 'default',
  windowStart: '2026-07-10T10:00:00.000Z',
  windowEnd: '2026-07-10T10:00:00.000Z',
  sourceChunks: ['c1'],
  text: 'summary with a [redacted:card-number] mention',
  voice: { scope: 'global', dials: { tone: 0, warmth: 0, wit: 0, charm: 0, specificity: 5, brevity: 5 } },
  provenance: {
    slot: 'llm',
    endpoint: 'hosted-aggregator',
    egress: { reach: 'egress', allowed: true, decidedBy: 'default', reason: 'content left the machine (no layer denied egress)' },
    guard: { behavior: 'redact-and-continue', outcome: 'redacted', guarded: true, maskedSpanCount: 1, spans: [{ kind: 'card-number', start: 7, length: 16 }], guardEndpoint: 'guard-local', reason: 'the egress guard masked 1 flagged span(s) before the content left the machine' },
  },
  schemaVersion: 1,
  createdAt: '2026-07-10T10:00:00.000Z',
})

const heldHop: GuardHold = {
  id: 'hold-1',
  workspaceId: 'default',
  sessionId: 'ses-guard',
  stage: 'distill',
  verdict: { behavior: 'hold-and-surface', outcome: 'held', guarded: true, maskedSpanCount: 1, spans: [{ kind: 'card-number', start: 7, length: 16 }], guardEndpoint: 'guard-local', reason: 'the egress guard flagged 1 span(s); strict mode suspended the hop for review' },
  status: 'held',
  createdAt: '2026-07-10T10:05:00.000Z',
}

test('GET /settings/ledger (served): guard column lights up (redacted) + held block with release/deny; POST resolve flips status', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-guard-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    app.store.saveDistillate(seedRedactedPass())
    app.guardHolds.add(heldHop)

    const res = await fetch(`${base}/settings/ledger`)
    assert.equal(res.status, 200)
    const html = await res.text()

    // The guard column renders the REDACTED verdict with its masked-span count (never the raw value).
    assert.match(html, /redacted · 1/, 'the guard column shows the redacted verdict + span count')
    assert.ok(!html.includes('4111'), 'no raw flagged value is ever rendered')
    // The egress hop shows it actually left the machine.
    assert.match(html, /class="ldg-egress"/)
    // The held block surfaces the suspended hop with its reason + a release/deny affordance.
    assert.match(html, /suspended — approve or deny/i)
    assert.match(html, /strict mode suspended the hop/)
    assert.match(html, /data-guard-hold="hold-1"[^>]*data-guard-action="release"/)
    assert.match(html, /data-guard-action="deny"/)
    assert.match(html, /kinds: card-number/, 'span kinds are surfaced (descriptors, never the value)')

    // Held listing over the API.
    const holds = (await (await fetch(`${base}/guard-holds?workspace=default`)).json()) as GuardHold[]
    assert.equal(holds.length, 1)
    assert.equal(holds[0]!.status, 'held')

    // Drive the RELEASE action — the status flips and is stamped.
    const released = await fetch(`${base}/guard-holds/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'default', id: 'hold-1', action: 'release' }),
    })
    assert.equal(released.status, 200)
    const body = (await released.json()) as GuardHold
    assert.equal(body.status, 'released')
    assert.ok(typeof body.resolvedAt === 'string')

    // Re-render: the held row now shows the resolved status, no longer offering release/deny.
    const after = await (await fetch(`${base}/settings/ledger`)).text()
    assert.match(after, /ldg-held-status">approved · not rerun</)

    // A bad action is a 400; an unknown id is a 404.
    const bad = await fetch(`${base}/guard-holds/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'hold-1', action: 'nope' }) })
    assert.equal(bad.status, 400)
    const missing = await fetch(`${base}/guard-holds/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'ghost', action: 'deny' }) })
    assert.equal(missing.status, 404)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('PUT /guard/policy: the verdict→behavior policy is a validated, editable config document', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-guardpol-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    // The seeded default: redact-and-continue, not acknowledged (the fail-closed starting posture).
    const seeded = (await (await fetch(`${base}/guard/policy`)).json()) as { behavior: string; acknowledgeUnguardedEgress: boolean }
    assert.equal(seeded.behavior, 'redact-and-continue')
    assert.equal(seeded.acknowledgeUnguardedEgress, false)

    // Switch to strict mode.
    const put = await fetch(`${base}/guard/policy`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'guard-policy', version: 2, behavior: 'hold-and-surface', acknowledgeUnguardedEgress: false }),
    })
    assert.equal(put.status, 200)
    const now = (await (await fetch(`${base}/guard/policy`)).json()) as { behavior: string }
    assert.equal(now.behavior, 'hold-and-surface')

    // A malformed policy is rejected 400 (contract-validated).
    const bad = await fetch(`${base}/guard/policy`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'guard-policy', version: 3, behavior: 'nonsense', acknowledgeUnguardedEgress: false }) })
    assert.equal(bad.status, 400)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})
