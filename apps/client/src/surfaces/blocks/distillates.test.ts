import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Distillate, QueryResult, Surface } from '@openinfo/contracts'
import { renderSurface, renderToHtml, type NowContext } from '../block-renderer/index.js'
import { defaultBlockRegistry } from './index.js'

// clockLabel renders viewer-local; pin this process to UTC so the clock assertion below is host-stable.
process.env.TZ = 'UTC'

const now: NowContext = { live: true, workspace: 'acme', title: 'Renewal — security review' }
const result = (items: unknown[]): QueryResult => ({ source: 'distillates', items, truncated: false })

const distillate = (id: string, text: string, windowEnd: string, extra: Partial<Distillate> = {}): Distillate => ({
  id, sessionId: 'ses', workspaceId: 'ws', windowStart: windowEnd, windowEnd,
  sourceChunks: [`c-${id}`], text,
  voice: { scope: 'session', dials: { tone: 3, warmth: 4, wit: 2, charm: 2, specificity: 9, brevity: 8 } },
  provenance: { slot: 'llm', endpoint: 'llm.fast' }, schemaVersion: 1, createdAt: windowEnd, ...extra,
})

const surface: Surface = {
  id: 's', name: 's', context: 'meeting', version: 1,
  stack: [
    { block: 'now' },
    {
      block: 'distillates', show: 'always',
      query: { source: 'distillates', params: { session: 'current' } },
      actions: [{ id: 'a-copy', label: 'Copy', verb: 'copy', params: {} }],
    },
  ],
}

test('the distillates block renders STORE-DERIVED windows: distilled text, a timestamp and a HUMAN why-line', () => {
  // The render half of the distillate-stream slice (#12): the renderer reads the hydrated `result.items`
  // (the Distillate records the engine served), NOT anything static in the block config. The seeded text
  // below is the proof of provenance — it can only come from the query result.
  const items = [distillate('dst-2', 'agreed to ship Thursday', '2026-07-07T14:30:00Z')]
  const html = renderToHtml(
    renderSurface({ surface, now, results: [undefined, result(items)] }, defaultBlockRegistry),
  )

  assert.match(html, /class="glbl">Transcript</) // the block's group label
  assert.match(html, /agreed to ship Thursday/) // store-derived window text (only via result.items)
  assert.match(html, /class="mk t">2:30p/) // each line carries its timestamp (clockLabel of windowEnd)
  assert.match(html, /class="why">from what was captured</) // HUMAN why (#117/#118), clock already leads the row
  // #118 REGRESSION: no endpoint id, no `via …` machine phrasing at this tier — the recorded trail
  // stays on the distillate's provenance, reachable on diagnostics surfaces + the ledger, not here.
  assert.doesNotMatch(html, /llm\.fast/)
  assert.doesNotMatch(html, /class="why">via /)
  // the copy affordance carries the window text (the app prepares; verbs never send)
  assert.match(html, /data-copy="agreed to ship Thursday"/)
})

test('empty is EXPLAINABLE, not silent: an always-visible distillates block renders a no-windows line', () => {
  const html = renderToHtml(
    renderSurface({ surface, now, results: [undefined, result([])] }, defaultBlockRegistry),
  )
  assert.match(html, /class="glbl">Transcript</) // the block still renders its label
  assert.match(html, /No transcript yet/)
  // #227: the live-empty why NAMES the Settings → Features toggle in human words (a pure renderer can't read
  // the runtime flag, so it names the enablement path unconditionally — the fields.ts pattern).
  assert.match(html, /turn on “Distill what is captured” in Settings → Features/)
  assert.match(html, /the transcript fills as you talk/)
  assert.doesNotMatch(html, /distill\.enabled|distill\.transcribe/) // no raw flag key leaks
})

test('top caps the rendered rows, and an on-match empty distillates block stays hidden', () => {
  const items = [
    distillate('d1', 'first window', '2026-07-07T14:00:00Z'),
    distillate('d2', 'second window', '2026-07-07T14:10:00Z'),
    distillate('d3', 'third window', '2026-07-07T14:20:00Z'),
  ]
  const capped: Surface = {
    ...surface,
    stack: [{ block: 'now' }, { block: 'distillates', top: 2, query: { source: 'distillates', params: {} } }],
  }
  const html = renderToHtml(renderSurface({ surface: capped, now, results: [undefined, result(items)] }, defaultBlockRegistry))
  assert.match(html, /first window/)
  assert.match(html, /second window/)
  assert.doesNotMatch(html, /third window/) // 3rd row cut by top:2

  // on-match + zero items → renderSurface drops the block before the renderer runs (explainable-empty)
  const onMatch: Surface = {
    ...surface,
    stack: [{ block: 'now' }, { block: 'distillates', show: 'on-match', query: { source: 'distillates', params: {} } }],
  }
  const hidden = renderToHtml(renderSurface({ surface: onMatch, now, results: [undefined, result([])] }, defaultBlockRegistry))
  assert.doesNotMatch(hidden, /class="glbl">Transcript</)
})
