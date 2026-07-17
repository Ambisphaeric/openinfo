import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { QueryResult, Summary, Surface } from '@openinfo/contracts'
import { renderSurface, renderToHtml, type NowContext } from '../block-renderer/index.js'
import { defaultBlockRegistry } from './index.js'

// clockLabel renders viewer-local; pin this process to UTC so the clock assertion below is host-stable.
process.env.TZ = 'UTC'

const now: NowContext = { live: true, workspace: 'acme', title: 'Renewal — security review' }
const result = (items: unknown[]): QueryResult => ({ source: 'summaries', items, truncated: false })

const summary = (over: Partial<Summary> = {}): Summary => ({
  id: 'sum-1', workspaceId: 'ws', sessionId: 'ses', level: 'five-minute',
  windowStart: '2026-07-07T14:25:00Z', windowEnd: '2026-07-07T14:30:00Z',
  children: [{ record: 'summary', id: 'r-1', at: '2026-07-07T14:25:00Z', role: 'child', level: 'rolling' }],
  bound: { childrenAvailable: 1, childrenConsumed: 1, evidenceAvailable: 0, evidenceConsumed: 0 },
  text: 'the team agreed to ship Thursday; Dana owns the deck',
  proposal: true, confidence: 0.6,
  provenance: { builder: 'bounded-hierarchical-summary', windowMs: 300_000, childLevel: 'rolling', templateId: 'tpl-summary-five-minute', slot: 'llm', endpoint: 'llm.fast' },
  revision: 1, schemaVersion: 1, createdAt: '2026-07-07T14:30:00Z', ...over,
})

const surface: Surface = {
  id: 's', name: 's', context: 'meeting', version: 1,
  stack: [
    { block: 'now' },
    { block: 'summaries', show: 'always', query: { source: 'summaries', params: { session: 'current', level: 'five-minute' } }, actions: [{ id: 'a-copy', label: 'Copy', verb: 'copy', params: {} }] },
  ],
}

test('the summaries block renders the model-proposed prose with a HUMAN why-line — no machine-speak, no ids, no scores', () => {
  const html = renderToHtml(renderSurface({ surface, now, results: [undefined, result([summary()])] }, defaultBlockRegistry))
  assert.match(html, /Summary/) // the block group label
  assert.match(html, /the team agreed to ship Thursday; Dana owns the deck/) // store-derived prose (only via result.items)
  assert.match(html, /Last five minutes/) // the human timescale label (no "five-minute" jargon)
  assert.match(html, /a draft you can correct/) // #189: the prose is a proposal, said plainly
  // No machine-speak leaks: no endpoint id, no template id, no raw confidence score.
  assert.doesNotMatch(html, /llm\.fast/)
  assert.doesNotMatch(html, /tpl-summary/)
  assert.doesNotMatch(html, /0\.6/)
  assert.match(html, /data-copy="the team agreed to ship Thursday; Dana owns the deck"/) // copy carries the prose
})

test('HONEST degraded: a summary with no model prose renders a calm unavailable line, never fabricated text', () => {
  const degraded = summary({ degraded: { reason: 'no summarizer endpoint' } })
  // buildSummary omits `text` entirely on a degraded summary; mirror that shape (no `text` key at all).
  delete (degraded as { text?: string }).text
  const html = renderToHtml(renderSurface({ surface, now, results: [undefined, result([degraded])] }, defaultBlockRegistry))
  assert.match(html, /Summary unavailable — no summary model connected/) // calm human degraded copy (hud-voice §3)
  assert.match(html, /nothing invented/) // the why reassures: no fabrication
  assert.match(html, /title="no summarizer endpoint"/) // the machine reason stays reachable on inspection, not in glance
})

test('empty is EXPLAINABLE, and an on-match empty summaries block stays hidden', () => {
  const html = renderToHtml(renderSurface({ surface, now, results: [undefined, result([])] }, defaultBlockRegistry))
  assert.match(html, /No summary yet/)
  assert.match(html, /a summary appears as the session builds up/)

  const onMatch: Surface = { ...surface, stack: [{ block: 'now' }, { block: 'summaries', show: 'on-match', query: { source: 'summaries', params: {} } }] }
  const hidden = renderToHtml(renderSurface({ surface: onMatch, now, results: [undefined, result([])] }, defaultBlockRegistry))
  assert.doesNotMatch(hidden, />Summary</)
})
