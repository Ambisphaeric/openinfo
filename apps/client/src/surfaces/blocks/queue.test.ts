import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { QueryResult, QueueStatus, Surface } from '@openinfo/contracts'
import { renderSurface, renderToHtml, type NowContext } from '../block-renderer/index.js'
import { defaultBlockRegistry } from './index.js'

const now: NowContext = { live: true, workspace: 'acme', title: 'Renewal — security review' }
const result = (items: unknown[]): QueryResult => ({ source: 'queue', items, truncated: false })

const status = (extra: Partial<QueueStatus> = {}): QueueStatus => ({
  pendingFiles: 2, pendingBytes: 4096, drainedFiles: 5, updatedAt: '2026-07-07T14:40:00Z',
  byKind: { audio: { pendingChunks: 3, pendingBytes: 3000 }, screen: { pendingChunks: 0, pendingBytes: 0 }, 'llm-work': { pendingChunks: 1, pendingBytes: 1096 } },
  eta: { basis: 'observed', etaMs: 12000, drainRateChunksPerSec: 0.3 },
  overflow: { policy: 'queue-for-idle', enforced: true },
  ...extra,
})

const surface: Surface = {
  id: 's', name: 's', context: 'meeting', version: 1,
  stack: [
    { block: 'now' },
    { block: 'queue', show: 'always', query: { source: 'queue', params: {} } },
  ],
}

test('the queue block renders STORE-DERIVED live status: per-kind backlog, honest ETA, overflow policy', () => {
  // The render half of the queue slice (#13): the renderer reads the hydrated `result.items[0]` (the
  // QueueStatus the engine injected from spool.ts), NOT anything static in the block config.
  const html = renderToHtml(
    renderSurface({ surface, now, results: [undefined, result([status()])] }, defaultBlockRegistry),
  )
  assert.match(html, /Queue · status/) // the block's group label
  assert.match(html, /backlog · audio 3 · screen 0 · llm-work 1/) // per-kind depth (only via result.items)
  assert.match(html, /ETA · ~12s to clear/) // honest ETA from the observed basis
  assert.match(html, /overflow queue-for-idle/) // the overflow policy in effect
})

test('a SEEDED FAILURE renders as VISIBLE text — never a hidden or silent block (the honest-failure mandate)', () => {
  const withFailure = status({
    lastFailure: { class: 'model-load', endpoint: 'lm-studio', hint: 'load a smaller model', serverMessage: 'Model "big" failed to load', at: '2026-07-07T14:39:00Z' },
  })
  const html = renderToHtml(
    renderSurface({ surface, now, results: [undefined, result([withFailure])] }, defaultBlockRegistry),
  )
  // THE PROOF: every part of the last failure is visible text — class, endpoint, verbatim server message, hint
  assert.match(html, /class="rel fail"/) // the failure row is marked, never folded into silence
  assert.match(html, /last failure · model-load · lm-studio/)
  assert.match(html, /Model "big" failed to load/) // the server's own words, captured verbatim (text, quotes unescaped)
  assert.match(html, /class="why">load a smaller model/) // the one-line fix hint
})

test('honest ETA basis: `none` never fabricates a number; and an unavailable status stays explainable', () => {
  const unknown = status({ eta: { basis: 'none' } })
  const html = renderToHtml(renderSurface({ surface, now, results: [undefined, result([unknown])] }, defaultBlockRegistry))
  assert.match(html, /ETA · not enough data yet/) // an unknown is unknown
  assert.doesNotMatch(html, /~\d+s/) // no invented number

  // no status row at all (the queue unwired) → an explainable line, still not a blank card
  const empty = renderToHtml(renderSurface({ surface, now, results: [undefined, result([])] }, defaultBlockRegistry))
  assert.match(empty, /Queue · status/)
  assert.match(empty, /Queue status unavailable/)
})
