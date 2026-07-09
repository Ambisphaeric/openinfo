import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { HintCandidate, QueryResult, Surface } from '@openinfo/contracts'
import { renderSurface, renderToHtml, type NowContext } from '../block-renderer/index.js'
import { defaultBlockRegistry } from './index.js'

const now: NowContext = { live: true, workspace: 'acme', title: 'Renewal — security review' }
const result = (items: unknown[]): QueryResult => ({ source: 'teach', items, truncated: false })

const candidate = (contains: string, extra: Partial<HintCandidate> = {}): HintCandidate => ({
  workspaceId: 'sales',
  pattern: { field: 'windowTitle', contains, weight: 0.9 },
  supportCount: 2,
  sampleSessionIds: ['s1', 's2'],
  ...extra,
})

const surface: Surface = {
  id: 's', name: 's', context: 'meeting', version: 1,
  stack: [
    { block: 'now' },
    {
      block: 'teach', show: 'always',
      query: { source: 'teach', params: { workspace: 'sales' } },
      actions: [
        { id: 'a-copy', label: 'Copy', verb: 'copy', params: {} },
        { id: 'a-dismiss', label: 'Dismiss', verb: 'dismiss', params: {} },
      ],
    },
  ],
}

test('the teach block renders STORE-DERIVED candidates: the suggested pattern + a support why-line', () => {
  // The render half of the teach slice (#11): the renderer reads the hydrated `result.items` (the
  // HintCandidates the engine derived from the workspace's reroute corrections), NOT anything static in
  // the block config. The seeded pattern below is the proof of provenance — it can only come from the
  // query result.
  const items = [
    candidate('Renewal — security review'),
    candidate('acme/infra', { pattern: { field: 'repoPath', contains: 'acme/infra', weight: 0.6 }, supportCount: 1, sampleSessionIds: ['s3'] }),
  ]
  const html = renderToHtml(
    renderSurface({ surface, now, results: [undefined, result(items)] }, defaultBlockRegistry),
  )

  assert.match(html, /Hints to review/) // the block's group label
  // store-derived suggested rule (only reachable via result.items), field label humanized
  assert.match(html, /window contains "Renewal — security review"/)
  assert.match(html, /repo contains "acme\/infra"/)
  // WHY-line built from the candidate's own trail: support count + which workspace it would teach
  assert.match(html, /class="why">2 reroutes → would teach sales/)
  assert.match(html, /class="why">1 reroute → would teach sales/) // singular reroute reads "1 reroute"
  // the accept/dismiss affordances render (copy carries the pattern text; verbs never apply — the user reviews)
  assert.match(html, /data-copy="Renewal — security review"/)
  assert.match(html, /data-verb="dismiss"/)
})

test('empty is EXPLAINABLE, not silent: an always-visible teach block renders a nothing-to-review line', () => {
  const html = renderToHtml(
    renderSurface({ surface, now, results: [undefined, result([])] }, defaultBlockRegistry),
  )
  assert.match(html, /Hints to review/) // the block still renders its label
  assert.match(html, /Nothing to review yet/)
  assert.match(html, /the teach loop suggests a hint once your reroutes agree/) // the explainable why
})

test('top caps the rendered rows, and an on-match empty teach block stays hidden', () => {
  const items = [candidate('first'), candidate('second'), candidate('third')]
  const capped: Surface = {
    ...surface,
    stack: [{ block: 'now' }, { block: 'teach', top: 2, query: { source: 'teach', params: {} } }],
  }
  const html = renderToHtml(renderSurface({ surface: capped, now, results: [undefined, result(items)] }, defaultBlockRegistry))
  assert.match(html, /contains "first"/)
  assert.match(html, /contains "second"/)
  assert.doesNotMatch(html, /contains "third"/) // 3rd row cut by top:2

  // on-match + zero items → renderSurface drops the block before the renderer runs (explainable-empty)
  const onMatch: Surface = {
    ...surface,
    stack: [{ block: 'now' }, { block: 'teach', show: 'on-match', query: { source: 'teach', params: {} } }],
  }
  const hidden = renderToHtml(renderSurface({ surface: onMatch, now, results: [undefined, result([])] }, defaultBlockRegistry))
  assert.doesNotMatch(hidden, /Hints to review/)
})
