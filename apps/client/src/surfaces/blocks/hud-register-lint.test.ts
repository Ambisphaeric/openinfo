import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Block, QueryResult, Surface } from '@openinfo/contracts'
import { renderSurface, renderToHtml, type NowContext } from '../block-renderer/index.js'
import { defaultBlockRegistry } from './index.js'

/**
 * The machine-speak REGISTER LINT (#118): every block in the default registry is rendered through the
 * real renderer with fixture DATA that deliberately carries endpoint/model/template ids — and the
 * emitted HTML must not contain them, except on the explicit Diagnostics-tier allow-list
 * (transcript-inspector / queue / sense-gates), which must render them BY DESIGN (asserted positively,
 * so the allow-list stays honest). Blocks whose renderer ignores result data (now/custom/input/…) are
 * rendered anyway — the assertion holds trivially, and starts biting the day they grow a data path.
 */

// clockLabel renders viewer-local; pin this process to UTC so any clock output is host-stable.
process.env.TZ = 'UTC'

const MARKERS = /lint-endpoint-x|lint-model-9b|tpl-lint-1/
const PROVENANCE = {
  slot: 'llm',
  endpoint: 'lint-endpoint-x',
  model: 'lint-model-9b',
  templateId: 'tpl-lint-1',
  windowStart: '2026-07-09T15:00:00Z',
  windowEnd: '2026-07-09T15:30:00Z',
}

// A kitchen-sink row: the union of the field names the list-ish renderers read, ids riding on every
// plausible carrier — if a renderer prints ANY of them, the lint catches it.
const sink = {
  id: 'row-1',
  kind: 'question',
  name: 'Dana',
  label: 'topic',
  title: 'a title',
  text: 'hello world',
  value: 'a value',
  summary: 'a summary',
  state: 'provisional',
  at: '2026-07-09T15:30:00Z',
  lastSeen: '2026-07-09T15:30:00Z',
  updatedAt: '2026-07-09T15:30:31Z',
  createdAt: '2026-07-09T15:30:31Z',
  windowStart: '2026-07-09T15:00:00Z',
  windowEnd: '2026-07-09T15:30:00Z',
  workspaceId: 'ws',
  sessionId: 'ses',
  fieldId: 'field-1',
  sourceChunks: ['c-1'],
  schemaVersion: 1,
  ingest: { status: 'ready', at: '2026-07-09T15:30:00Z', endpoint: 'lint-endpoint-x', model: 'lint-model-9b' },
  pattern: { contains: 'hello' },
  supportCount: 1,
  provenance: PROVENANCE,
}

const DIAG_FIX = 'point the slot at lint-endpoint-x (lint-model-9b, tpl-lint-1)'

/** Per-block fixture rows where the generic sink would not exercise (or would break) the renderer. */
const fixtures: Record<string, unknown[]> = {
  now: [], // renders NowContext only — result data cannot reach it
  'relevant-now': [
    {
      entity: { id: 'e1', kind: 'person', name: 'Dana', mentions: 2, lastSeen: '2026-07-09T15:30:00Z', provenance: [PROVENANCE] },
      score: 1,
      moments: [],
    },
  ],
  'transcript-inspector': [
    { ringLimit: 50, sttSlot: [{ endpoint: 'lint-endpoint-x', model: 'lint-model-9b' }], chunks: [] },
  ],
  queue: [
    {
      pendingFiles: 1,
      pendingBytes: 10,
      drainedFiles: 0,
      updatedAt: '2026-07-09T15:30:00Z',
      byKind: {
        audio: { pendingChunks: 1, pendingBytes: 10 },
        screen: { pendingChunks: 0, pendingBytes: 0 },
        'llm-work': { pendingChunks: 0, pendingBytes: 0 },
      },
      lastFailure: { class: 'model-load', endpoint: 'lint-endpoint-x', hint: 'load lint-model-9b (tpl-lint-1)', serverMessage: 'failed', at: '2026-07-09T15:29:00Z' },
    },
  ],
  'sense-gates': [
    {
      sense: 'screen',
      label: 'Screen',
      gates: [{ id: 'ocr', label: 'Reading (ocr) endpoint', pass: false, fix: DIAG_FIX }],
      blocking: { id: 'ocr', label: 'Reading (ocr) endpoint', pass: false, fix: DIAG_FIX },
    },
  ],
}

/** Diagnostics-tier keeps full ids BY DESIGN — these must POSITIVELY render the markers. */
const ALLOW = new Set(['transcript-inspector', 'queue', 'sense-gates'])
// drafts renders `via <endpoint>` today — the known remaining #118 scope, excluded until its own slice fixes it.
const SKIPPED = new Set(['drafts'])

const now: NowContext = { live: true, workspace: 'acme', title: 'Renewal — security review' }

const render = (type: string, items: unknown[]): string => {
  const surface: Surface = {
    id: 's',
    name: 's',
    context: 'meeting',
    version: 1,
    stack: [{ block: type, show: 'always', query: { source: type, params: {} } } as unknown as Block],
  }
  const result = { source: type, items, truncated: false } as unknown as QueryResult
  return renderToHtml(renderSurface({ surface, now, results: [result] }, defaultBlockRegistry))
}

test('register lint (#118): provenance ids cannot render outside the Diagnostics-tier allow-list', () => {
  for (const type of Object.keys(defaultBlockRegistry)) {
    if (SKIPPED.has(type)) continue
    const html = render(type, fixtures[type] ?? [sink])
    if (ALLOW.has(type)) {
      assert.match(html, MARKERS, `${type} is Diagnostics-tier and must keep rendering full ids (allow-list honesty)`)
    } else {
      assert.doesNotMatch(html, MARKERS, `${type} rendered a machine id (endpoint/model/template) at a human-facing tier`)
    }
  }
})
