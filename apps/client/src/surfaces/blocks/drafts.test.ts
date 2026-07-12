import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Draft, QueryResult, Surface } from '@openinfo/contracts'
import { renderSurface, renderToHtml, type NowContext } from '../block-renderer/index.js'
import { defaultBlockRegistry } from './index.js'

const now: NowContext = { live: true, workspace: 'acme', title: 'Renewal — security review' }
const result = (items: unknown[]): QueryResult => ({ source: 'drafts', items, truncated: false })

const draft = (id: string, body: string, extra: Partial<Draft> = {}): Draft => ({
  id, sessionId: 'ses', workspaceId: 'ws', actKind: 'follow-up-draft', body, status: 'prepared',
  voice: { scope: 'session', dials: { tone: 3, warmth: 4, wit: 2, charm: 2, specificity: 9, brevity: 8 } },
  provenance: { templateId: 'tpl-followup-default', slot: 'llm', endpoint: 'llm.fast', sourceDistillates: ['dst-1', 'dst-2'], sourceMoments: ['mom-1'] },
  schemaVersion: 1, createdAt: '2026-07-07T15:02:11Z', ...extra,
})

const surface: Surface = {
  id: 's', name: 's', context: 'meeting', version: 1,
  stack: [
    { block: 'now' },
    {
      block: 'drafts', show: 'always',
      query: { source: 'drafts', params: { session: 'current' } },
      actions: [{ id: 'a-copy', label: 'Copy', verb: 'copy', params: {} }],
    },
  ],
}

test('the drafts block renders STORE-DERIVED drafts: the prepared body + a provenance why-line', () => {
  // The render half of the drafts slice (#10): the renderer reads the hydrated `result.items` (the
  // Draft records the engine served), NOT anything static in the block config. The seeded body below is
  // the proof of provenance — it can only come from the query result.
  const items = [draft('drf-1', 'Hi Dana, thanks for the time today — recap and next steps below.')]
  const html = renderToHtml(
    renderSurface({ surface, now, results: [undefined, result(items)] }, defaultBlockRegistry),
  )

  assert.match(html, /Prepared drafts/) // the block's group label
  assert.match(html, /Hi Dana, thanks for the time today/) // store-derived body (only via result.items)
  // WHY-line built from the draft's own provenance: act kind + human source counts. #118: NO machine trail
  // (endpoint/model/template id) at this human tier, nor the old `via <endpoint>` phrasing — it stays
  // recorded on provenance and reachable on diagnostics + the ledger, just not rendered here.
  assert.match(html, /class="why">follow-up draft · from 2 distillates \+ 1 moment</)
  assert.doesNotMatch(html, /via llm\.fast|class="why">[^<]*via /)
  // the copy affordance carries the body (the app prepares; the human executes — verbs never send)
  assert.match(html, /data-copy="Hi Dana, thanks for the time today/)
})

test('empty is EXPLAINABLE, not silent: an always-visible drafts block renders a no-drafts line', () => {
  const html = renderToHtml(
    renderSurface({ surface, now, results: [undefined, result([])] }, defaultBlockRegistry),
  )
  assert.match(html, /Prepared drafts/) // the block still renders its label
  assert.match(html, /No drafts prepared yet/)
  assert.match(html, /a follow-up draft is prepared when a session ends/) // the explainable why
})

test('top caps the rendered rows, and an on-match empty drafts block stays hidden', () => {
  const items = [draft('d1', 'first draft'), draft('d2', 'second draft'), draft('d3', 'third draft')]
  const capped: Surface = {
    ...surface,
    stack: [{ block: 'now' }, { block: 'drafts', top: 2, query: { source: 'drafts', params: {} } }],
  }
  const html = renderToHtml(renderSurface({ surface: capped, now, results: [undefined, result(items)] }, defaultBlockRegistry))
  assert.match(html, /first draft/)
  assert.match(html, /second draft/)
  assert.doesNotMatch(html, /third draft/) // 3rd row cut by top:2

  // on-match + zero items → renderSurface drops the block before the renderer runs (explainable-empty)
  const onMatch: Surface = {
    ...surface,
    stack: [{ block: 'now' }, { block: 'drafts', show: 'on-match', query: { source: 'drafts', params: {} } }],
  }
  const hidden = renderToHtml(renderSurface({ surface: onMatch, now, results: [undefined, result([])] }, defaultBlockRegistry))
  assert.doesNotMatch(hidden, /Prepared drafts/)
})
