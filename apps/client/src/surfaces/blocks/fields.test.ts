import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FieldValue, QueryResult, Surface } from '@openinfo/contracts'
import { renderSurface, renderToHtml, type NowContext } from '../block-renderer/index.js'
import { defaultBlockRegistry } from './index.js'

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

test('the fields block renders each field value with its label, value, and a provenance why-line', () => {
  const items = [fieldValue('field-topic', 'topic', 'Q3 planning')]
  const html = renderToHtml(renderSurface({ surface, now, results: [undefined, result(items)] }, defaultBlockRegistry))

  assert.match(html, /Fields · fast/) // the block's group label
  assert.match(html, /Q3 planning/) // store-derived field value (only via result.items)
  assert.match(html, /class="mk t">topic/) // the field label
  // the why-line composed ENTIRELY from provenance: via <endpoint> · <model> · <template id>
  assert.match(html, /class="why">via this-mac · qwen2\.5-7b · tpl-field-topic/)
  // the copy affordance carries the value (the app prepares; verbs never send)
  assert.match(html, /data-copy="Q3 planning"/)
})

test('a provisional field renders the #66 micro-state dot (a real signal, not decoration)', () => {
  const items = [fieldValue('field-topic', 'topic', 'Q3 planning')]
  const html = renderToHtml(renderSurface({ surface, now, results: [undefined, result(items)] }, defaultBlockRegistry))
  assert.match(html, /provisional/) // the dot's tone class / title carries the state
})

test('empty is EXPLAINABLE, not silent: an always-visible fields block renders a no-fields line', () => {
  const html = renderToHtml(renderSurface({ surface, now, results: [undefined, result([])] }, defaultBlockRegistry))
  assert.match(html, /Fields · fast/)
  assert.match(html, /No fields yet/)
  assert.match(html, /fields fill as fast-field prompts run/)
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
  assert.doesNotMatch(hidden, /Fields · fast/)
})
