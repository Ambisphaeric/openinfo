import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FieldValue, QueryResult, Surface } from '@openinfo/contracts'
import { renderSurface, renderToHtml, type NowContext } from '../block-renderer/index.js'
import { defaultBlockRegistry } from './index.js'

// clockLabel renders viewer-local; pin this process to UTC so the clock assertion below is host-stable.
process.env.TZ = 'UTC'

const now: NowContext = { live: true, workspace: 'acme', title: 'Renewal — security review' }
const result = (items: unknown[], suppressed?: number): QueryResult => ({
  source: 'fields',
  items,
  truncated: false,
  ...(suppressed !== undefined ? { suppressed } : {}),
})

const fieldValue = (fieldId: string, label: string, value: string, extra: Partial<FieldValue> = {}): FieldValue => ({
  id: `fv:ws::${fieldId}`,
  fieldId,
  workspaceId: 'ws',
  sessionId: 'ses',
  label,
  value,
  state: 'provisional',
  provenance: { templateId: `tpl-${fieldId}`, slot: 'llm', endpoint: 'this-mac', model: 'qwen2.5-7b', windowStart: '2026-07-09T12:00:00Z', windowEnd: '2026-07-09T12:00:30Z' },
  updatedAt: '2026-07-09T12:00:31Z',
  schemaVersion: 1,
  ...extra,
})

const surface: Surface = {
  id: 's',
  name: 's',
  context: 'meeting',
  version: 1,
  stack: [
    { block: 'now' },
    {
      block: 'fields',
      show: 'always',
      query: { source: 'fields', params: { session: 'current' } },
      actions: [{ id: 'a-copy', label: 'Copy', verb: 'copy', params: {} }],
    },
  ],
}

test('the fields block renders each field value with its label, value, and a HUMAN recency why-line', () => {
  const items = [fieldValue('field-topic', 'topic', 'Q3 planning')]
  const html = renderToHtml(renderSurface({ surface, now, results: [undefined, result(items)] }, defaultBlockRegistry))

  assert.match(html, /class="glbl">Fields</) // the block's group label
  assert.match(html, /Q3 planning/) // store-derived field value (only via result.items)
  assert.match(html, /class="mk t">topic/) // the field label
  // the why-line is HUMAN (#117/#118): recency from the value's updatedAt, never the machine trail
  assert.match(html, /class="why">updated 12:00p</)
  // #118 REGRESSION: the HUD-tier render must not leak the endpoint, model id, or template id, nor the
  // old `via …` machine phrasing — the full trail stays on diagnostics surfaces + the ledger, not here.
  assert.doesNotMatch(html, /this-mac|qwen2\.5-7b|tpl-field-topic/)
  assert.doesNotMatch(html, /class="why">via /)
  // the copy affordance carries the value (the app prepares; verbs never send)
  assert.match(html, /data-copy="Q3 planning"/)
})

test('the fields why falls back (#118): provenance window when updatedAt is unusable, else "updated this session"', () => {
  // updatedAt is type-required, so the no-updatedAt arm is an unparseable stamp (clockLabel → '').
  const windowed = fieldValue('field-a', 'topic', 'window-derived clock', {
    updatedAt: 'not-a-date',
    provenance: { templateId: 'tpl-a', slot: 'llm', endpoint: 'this-mac', windowStart: '2026-07-09T15:00:00Z', windowEnd: '2026-07-09T15:30:00Z' },
  })
  const bare = fieldValue('field-b', 'notes', 'no clock at all', {
    updatedAt: 'not-a-date',
    provenance: { templateId: 'tpl-b', slot: 'llm', endpoint: 'this-mac' },
  })
  const html = renderToHtml(renderSurface({ surface, now, results: [undefined, result([windowed, bare])] }, defaultBlockRegistry))
  assert.match(html, /class="why">updated 3:30p</) // windowEnd drives the clock when updatedAt cannot
  assert.match(html, /class="why">updated this session</) // no usable time anywhere → the honest constant
  assert.doesNotMatch(html, /class="why">via /) // the fallback chain never regresses to machine phrasing
})

test('a provisional field renders the #66 micro-state dot (a real signal, not decoration)', () => {
  const items = [fieldValue('field-topic', 'topic', 'Q3 planning')]
  const html = renderToHtml(renderSurface({ surface, now, results: [undefined, result(items)] }, defaultBlockRegistry))
  assert.match(html, /provisional/) // the dot's tone class / title carries the state
})

test('empty is EXPLAINABLE, not silent: an always-visible fields block renders a no-fields line', () => {
  const html = renderToHtml(renderSurface({ surface, now, results: [undefined, result([])] }, defaultBlockRegistry))
  assert.match(html, /class="glbl">Fields</)
  assert.match(html, /No fields yet/)
  // #100/#118: the empty state points at the Settings toggle in HUMAN terms — never the raw flag key
  assert.match(html, /turn on Fields in Settings → Features/)
  assert.doesNotMatch(html, /distill\.fields/)
  assert.match(html, /fields fill as prompts run/)
})

test('an all-dismissed empty discloses the suppressed count (#66), and an on-match empty stays hidden', () => {
  const disclosed = renderToHtml(renderSurface({ surface, now, results: [undefined, result([], 2)] }, defaultBlockRegistry))
  assert.match(disclosed, /No fields shown/)
  assert.match(disclosed, /2 fields dismissed/)

  const onMatch: Surface = {
    ...surface,
    stack: [{ block: 'now' }, { block: 'fields', show: 'on-match', query: { source: 'fields', params: {} } }],
  }
  const hidden = renderToHtml(renderSurface({ surface: onMatch, now, results: [undefined, result([])] }, defaultBlockRegistry))
  assert.doesNotMatch(hidden, /class="glbl">Fields</)
})
