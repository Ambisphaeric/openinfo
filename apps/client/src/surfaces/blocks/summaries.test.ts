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
  // #242: a degraded row has no value to copy — the copy affordance is SUPPRESSED, never a live button that
  // would put an empty string on the clipboard.
  assert.doesNotMatch(html, /data-copy=""/)
  assert.doesNotMatch(html, /data-verb="copy"/)
})

test('empty is EXPLAINABLE, and an on-match empty summaries block stays hidden', () => {
  const html = renderToHtml(renderSurface({ surface, now, results: [undefined, result([])] }, defaultBlockRegistry))
  assert.match(html, /No summary yet/)
  // #227: the live-empty why NAMES the Settings → Features toggle in human words — a pure renderer can't read
  // the runtime flag, so it names the enablement path unconditionally (the fields.ts pattern).
  assert.match(html, /turn on “Build a summary timeline” in Settings → Features/)
  assert.match(html, /a summary builds as the session runs/)
  assert.doesNotMatch(html, /summaries\.enabled/) // no raw flag key leaks

  const onMatch: Surface = { ...surface, stack: [{ block: 'now' }, { block: 'summaries', show: 'on-match', query: { source: 'summaries', params: {} } }] }
  const hidden = renderToHtml(renderSurface({ surface: onMatch, now, results: [undefined, result([])] }, defaultBlockRegistry))
  assert.doesNotMatch(hidden, />Summary</)
})

test('#246 correctable: a live row grows the pencil affordance ONLY where the surface threads the correction context', () => {
  // No correction context threaded ⇒ no edit affordance (opt-in; a surface that never wired it shows none).
  const off = renderToHtml(renderSurface({ surface, now, results: [undefined, result([summary()])] }, defaultBlockRegistry))
  assert.doesNotMatch(off, /data-verb="summary-edit"/)
  // Context threaded ⇒ a live row grows the pencil (client-local open verb), still copy carries the prose.
  const on = renderToHtml(renderSurface({ surface, now, results: [undefined, result([summary()])], summaryEdit: {} }, defaultBlockRegistry))
  assert.match(on, /data-verb="summary-edit"[^>]*data-summary="sum-1"/)
  assert.match(on, /data-copy="the team agreed to ship Thursday; Dana owns the deck"/)
})

test('#246 correctable: a degraded row gets NO edit affordance (nothing to correct until a model connects)', () => {
  const degraded = summary({ degraded: { reason: 'no summarizer endpoint' } })
  delete (degraded as { text?: string }).text
  const html = renderToHtml(renderSurface({ surface, now, results: [undefined, result([degraded])], summaryEdit: {} }, defaultBlockRegistry))
  assert.doesNotMatch(html, /data-verb="summary-edit"/)
  assert.doesNotMatch(html, /<textarea/)
})

test('#246 correctable: the open row swaps to an inline editor prefilled with the current prose, live Save + Cancel', () => {
  const html = renderToHtml(renderSurface({ surface, now, results: [undefined, result([summary()])], summaryEdit: { editing: 'sum-1' } }, defaultBlockRegistry))
  assert.match(html, /<textarea[^>]*class="sum-edit-text"[^>]*data-summary="sum-1"[^>]*>the team agreed to ship Thursday; Dana owns the deck<\/textarea>/)
  assert.match(html, /data-verb="summary-correct"[^>]*data-summary="sum-1"[^>]*data-workspace="ws"/) // Save carries the write payload
  assert.match(html, /data-verb="summary-edit-cancel"/) // Cancel is live
  assert.match(html, /class="sum-status"/) // an empty honest-failure region the controller paints into
})

test('#246 corrected: a user-corrected row shows the corrected prose, marks it your edit, and copy carries the CORRECTED bare text', () => {
  const corrected = summary({
    id: 'sum-user-1', text: 'Dana owns the deck; we ship Thursday', proposal: false, source: 'user',
    correction: { at: '2026-07-07T14:31:00Z' }, corrects: 'sum-1', confidence: 1,
    provenance: { builder: 'bounded-hierarchical-summary', windowMs: 300_000, childLevel: 'rolling', templateId: 'tpl-summary-five-minute' },
  })
  const html = renderToHtml(renderSurface({ surface, now, results: [undefined, result([corrected])], summaryEdit: {} }, defaultBlockRegistry))
  assert.match(html, /Dana owns the deck; we ship Thursday/) // the corrected prose shows
  assert.match(html, /class="corr">edited by you/) // the honest correction marker
  assert.doesNotMatch(html, /a draft you can correct/) // a correction is your own text, no longer "a draft"
  // Copy stays value-only: it now carries the CORRECTED bare text (extends the copy-value invariant).
  assert.match(html, /data-copy="Dana owns the deck; we ship Thursday"/)
  // The row is still re-correctable (the pencil remains).
  assert.match(html, /data-verb="summary-edit"[^>]*data-summary="sum-user-1"/)
})

test('#227/#215 summaries words two DISTINCT empty states: no session running vs live-but-empty', () => {
  // The summaries source is session-scoped, so it carries `noCurrentSession` (#210) like its siblings. With no
  // live session the empty stays session-first (start one); live-but-empty names the enablement toggle. The two
  // must be visibly distinct (the #215 non-tautological rule), and neither may leak a raw flag key.
  const noSession = renderToHtml(
    renderSurface({ surface, now: { live: false }, results: [undefined, { source: 'summaries', items: [], truncated: false, noCurrentSession: true }] }, defaultBlockRegistry),
  )
  assert.match(noSession, /No session running/)
  assert.match(noSession, /a summary appears here once you start a session/)
  assert.doesNotMatch(noSession, /Settings → Features/) // session gate first — not the enablement line

  const liveEmpty = renderToHtml(renderSurface({ surface, now, results: [undefined, result([])] }, defaultBlockRegistry))
  assert.doesNotMatch(liveEmpty, /No session running/) // the two states never collapse into one line
  assert.match(liveEmpty, /turn on “Build a summary timeline” in Settings → Features/)
  assert.notEqual(noSession, liveEmpty) // visibly distinct end-to-end
})
