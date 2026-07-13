import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Distillate } from '@openinfo/contracts'
import { createSecureTestEngineApp as createEngineApp, secureTestFetch as fetch } from './test-control-plane.js'

/**
 * DRIVEN served test for the Audit-ledger surface (#65), per the QA rule (a served-surface slice needs a
 * REAL driven test against the actual rendered view, not just a route test). It boots the engine, seeds a
 * distillate with token usage directly into the store, then GETs the SERVED /settings/ledger HTML over
 * HTTP and asserts the hop trail renders — endpoint, tokens in/out, the honest guard/egress absences — so
 * a handler failure surfaces as visible text here rather than a silent blank pane.
 */

const seedDistillate = (over: Partial<Distillate> & { id: string; createdAt: string }): Distillate => ({
  sessionId: 'ses-ledger',
  workspaceId: 'default',
  windowStart: over.createdAt,
  windowEnd: over.createdAt,
  sourceChunks: ['c1'],
  text: 'Dana asked for retention language by Thursday.',
  voice: { scope: 'global', dials: { tone: 0, warmth: 0, wit: 0, charm: 0, specificity: 5, brevity: 5 } },
  provenance: { slot: 'llm', endpoint: 'llm.fast' },
  schemaVersion: 1,
  ...over,
})

test('GET /settings/ledger (served): a seeded pass renders its hop trail with token accounting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-ledger-'))
  const app = createEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, resolve))
  try {
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`

    // Empty first: the served page must be an honest card, not a blank/500.
    const empty = await fetch(`${base}/settings/ledger`)
    assert.equal(empty.status, 200)
    const emptyHtml = await empty.text()
    assert.match(emptyHtml, /No passes recorded yet/, 'empty ledger renders its honest empty state')
    assert.match(emptyHtml, /Audit ledger/, 'the section is reachable in the served shell')

    // Seed a MEASURED distill pass and one ESTIMATED pass into the default workspace.
    app.store.saveDistillate(
      seedDistillate({
        id: 'dst-measured',
        createdAt: '2026-07-10T10:00:00.000Z',
        provenance: { slot: 'llm', endpoint: 'llm.fast', model: 'llama-3.2-3b', usage: { estimated: false, promptTokens: 210, completionTokens: 34, totalTokens: 244, durationMs: 612 } },
      }),
    )
    app.store.saveDistillate(
      seedDistillate({
        id: 'dst-estimated',
        createdAt: '2026-07-10T10:01:00.000Z',
        provenance: { slot: 'llm', endpoint: 'llm.local', usage: { estimated: true, promptTokens: 12, completionTokens: 5, totalTokens: 17 } },
      }),
    )

    const res = await fetch(`${base}/settings/ledger`)
    assert.equal(res.status, 200)
    const html = await res.text()

    // The measured pass: endpoint, model, and its in/out token counts are visible text.
    assert.match(html, /llm\.fast/)
    assert.match(html, /llama-3\.2-3b/)
    assert.match(html, /210 in · 34 out/)
    // The estimated pass is MARKED est and the summary flags estimation.
    assert.match(html, /class="ldg-est">est</)
    assert.match(html, /some estimated/)
    // Guard (#63): these local passes carry no verdict (no egress ⇒ no filter), so the guard column shows
    // the honest "— no guard" absence and the footer explains the live column. Egress (#64) renders from
    // data — no egress decision on these seeded passes ⇒ the honest local default.
    assert.match(html, /no guard/i)
    assert.match(html, /guard column \(#63\)/)
    assert.match(html, /egress column \(#64\)/)
    assert.match(html, /class="ldg-local"[^>]*>local</)
    // The summary totals both passes' input tokens (210 + 12 = 222).
    assert.match(html, /222<\/span> tokens in/)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})
