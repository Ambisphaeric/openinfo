import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { QueryResult, SenseLaneSnapshot, Surface } from '@openinfo/contracts'
import { patchLiveSenseResults, reconcileLiveSenseHydration, sanitizeSenseLaneSnapshot } from './sense-lane-cache.js'

const lane = <Source extends SenseLaneSnapshot['source']>(
  source: Source,
  over: Partial<Extract<SenseLaneSnapshot, { source: Source }>> = {},
): Extract<SenseLaneSnapshot, { source: Source }> => ({
  workspaceId: 'acme',
  sessionId: 'ses-live',
  source,
  disposition: 'waiting',
  health: 'healthy',
  reason: 'awaiting-capture',
  updatedAt: '2026-07-13T14:47:00Z',
  ...over,
}) as Extract<SenseLaneSnapshot, { source: Source }>

const fullScreen = (): Extract<SenseLaneSnapshot, { source: 'screen' }> => lane('screen', {
  disposition: 'processed',
  reason: 'processed',
  latestCapture: { id: 'cap-1', capturedAt: '2026-07-13T14:46:58Z' },
  latestProcessing: {
    captureId: 'cap-1',
    capturedAt: '2026-07-13T14:46:58Z',
    completedAt: '2026-07-13T14:46:59.240Z',
    outcome: 'processed',
    lagMs: 1240,
    basis: 'capture-to-processing-completion',
  },
  latestObservation: { id: 'obs-1', occurredAt: '2026-07-13T14:46:57Z', outcome: 'delta-skipped' },
})

test('the live-sense sanitizer rebuilds an exact closed snapshot and rejects widening at every level', () => {
  const input = fullScreen()
  const safe = sanitizeSenseLaneSnapshot(input)
  assert.deepEqual(safe, input)
  assert.notEqual(safe, input)
  assert.notEqual(safe?.latestCapture, input.latestCapture)
  assert.notEqual(safe?.latestProcessing, input.latestProcessing)
  assert.equal(safe?.source === 'screen' && safe.latestObservation !== input.latestObservation, true)

  const widened = [
    { ...input, text: 'raw transcript' },
    { ...input, latestCapture: { ...input.latestCapture!, pixels: 'raw pixels' } },
    { ...input, latestProcessing: { ...input.latestProcessing!, endpoint: 'private-endpoint' } },
    { ...input, latestObservation: { ...input.latestObservation!, error: 'private stack' } },
  ]
  for (const payload of widened) assert.equal(sanitizeSenseLaneSnapshot(payload), undefined)
})

test('the live-sense sanitizer rejects malformed enums, timestamps, optional values, and source widening', () => {
  for (const payload of [
    { ...fullScreen(), source: 'speaker-john' },
    { ...fullScreen(), disposition: 'invented' },
    { ...fullScreen(), health: 'great' },
    { ...fullScreen(), reason: 'model-said-so' },
    { ...fullScreen(), updatedAt: 'yesterday' },
    { ...fullScreen(), sessionId: undefined },
    { ...fullScreen(), latestProcessing: { ...fullScreen().latestProcessing!, lagMs: -1 } },
  ]) assert.equal(sanitizeSenseLaneSnapshot(payload), undefined)
})

const surface: Surface = {
  id: 'surf-pill',
  name: 'Pill',
  context: 'meeting',
  version: 1,
  stack: [{ block: 'sense-lanes', query: { source: 'live-senses', params: { session: 'current' }, top: 3 } }],
}
const canonical = (): SenseLaneSnapshot[] => [lane('mic'), lane('system-audio'), lane('screen')]
const result = (items: unknown[], source: QueryResult['source'] = 'live-senses'): QueryResult => ({ source, items, truncated: false })

test('cache patching replaces only the matching source and preserves canonical order', () => {
  const original = canonical()
  const update = lane('system-audio', { disposition: 'processed', reason: 'processed', updatedAt: '2026-07-13T14:47:01Z' })
  const patched = patchLiveSenseResults({
    surface,
    results: [result(original)],
    lane: update,
  })
  assert.ok(patched)
  assert.deepEqual(patched[0]?.items.map((item) => (item as SenseLaneSnapshot).source), ['mic', 'system-audio', 'screen'])
  assert.equal((patched[0]?.items[1] as SenseLaneSnapshot).disposition, 'processed')
  assert.equal(original[1]?.disposition, 'waiting', 'the hydrated cache is copied, not mutated')
})

test('cache patching rejects workspace/session mismatch, wrong result source, wrong block source, and noncanonical hydration', () => {
  const update = lane('mic', { disposition: 'processed', reason: 'processed' })
  const attempt = (over: Partial<Parameters<typeof patchLiveSenseResults>[0]> = {}) => patchLiveSenseResults({
    surface,
    results: [result(canonical())],
    lane: update,
    ...over,
  })
  assert.equal(attempt({ lane: lane('mic', { workspaceId: 'other' }) }), undefined)
  assert.equal(attempt({ lane: lane('mic', { sessionId: 'other' }) }), undefined)
  assert.equal(attempt({ results: [result(canonical(), 'senses')] }), undefined)
  assert.equal(attempt({
    surface: { ...surface, stack: [{ block: 'sense-gates', query: { source: 'senses', params: {} } }] },
  }), undefined)
  assert.equal(attempt({ results: [result([lane('screen'), lane('system-audio'), lane('mic')])] }), undefined)
  assert.equal(attempt({ results: [result([lane('system-audio'), lane('mic')])] }), undefined, 'a sub-trio out of canonical order is not a hydration')
  assert.equal(attempt({ results: [result([lane('mic'), lane('mic')])] }), undefined, 'a duplicated source is not a hydration')
  assert.equal(attempt({ results: [result([])] }), undefined, 'an empty result carries no scope to authenticate against')
  assert.equal(attempt({ results: [result([lane('mic'), lane('system-audio', { workspaceId: 'other' }), lane('screen')])] }), undefined)
})

test('a sub-trio hydration keeps its live fast path for every hydrated source (#193)', () => {
  const subTrioSurface: Surface = {
    ...surface,
    stack: [{ block: 'sense-lanes', query: { source: 'live-senses', params: { session: 'current' }, top: 2 } }],
  }
  const hydrated = [lane('mic'), lane('system-audio')]
  const patched = patchLiveSenseResults({
    surface: subTrioSurface,
    results: [result(hydrated)],
    lane: lane('system-audio', { disposition: 'processed', reason: 'processed', updatedAt: '2026-07-13T14:47:01Z' }),
  })
  assert.ok(patched, 'a hydrated source in a sub-trio block accepts the payload patch')
  assert.deepEqual(patched[0]?.items.map((item) => (item as SenseLaneSnapshot).source), ['mic', 'system-audio'])
  assert.equal((patched[0]?.items[1] as SenseLaneSnapshot).disposition, 'processed')
  assert.equal(hydrated[1]?.disposition, 'waiting', 'the hydrated cache is copied, not mutated')

  // The same guards still hold inside the sub-trio scope: stale updates and foreign scopes are dropped.
  assert.equal(patchLiveSenseResults({
    surface: subTrioSurface,
    results: [result([lane('mic'), lane('system-audio', { updatedAt: '2026-07-13T14:47:02Z' })])],
    lane: lane('system-audio', { disposition: 'processed', reason: 'processed', updatedAt: '2026-07-13T14:47:01Z' }),
  }), undefined)
  assert.equal(patchLiveSenseResults({
    surface: subTrioSurface,
    results: [result(hydrated)],
    lane: lane('system-audio', { workspaceId: 'other', updatedAt: '2026-07-13T14:47:01Z' }),
  }), undefined)
})

test('a source the query never hydrated is never patched in (#193)', () => {
  const subTrioSurface: Surface = {
    ...surface,
    stack: [{ block: 'sense-lanes', query: { source: 'live-senses', params: { session: 'current' }, top: 2 } }],
  }
  const ignored = patchLiveSenseResults({
    surface: subTrioSurface,
    results: [result([lane('mic'), lane('system-audio')])],
    lane: lane('screen', {
      disposition: 'delta-skipped',
      reason: 'delta-skipped',
      updatedAt: '2026-07-13T14:47:01Z',
      latestObservation: { id: 'obs', occurredAt: '2026-07-13T14:47:01Z', outcome: 'delta-skipped' },
    }),
  })
  assert.equal(ignored, undefined, 'hydration alone decides which sources exist; an event cannot add one')
  // Single-lane hydration: only that exact source is patchable.
  const micOnly = [lane('mic')]
  assert.equal(patchLiveSenseResults({
    surface: subTrioSurface,
    results: [result(micOnly)],
    lane: lane('system-audio', { disposition: 'processed', reason: 'processed', updatedAt: '2026-07-13T14:47:01Z' }),
  }), undefined)
  const micPatched = patchLiveSenseResults({
    surface: subTrioSurface,
    results: [result(micOnly)],
    lane: lane('mic', { disposition: 'processed', reason: 'processed', updatedAt: '2026-07-13T14:47:01Z' }),
  })
  assert.equal((micPatched?.[0]?.items[0] as SenseLaneSnapshot).disposition, 'processed')
  assert.equal(micPatched?.[0]?.items.length, 1)
})

test('cache patching rejects an older source update but permits an equal-timestamp replacement', () => {
  const current = canonical()
  current[0] = lane('mic', { updatedAt: '2026-07-13T14:47:02Z' })
  const attempt = (updatedAt: string) => patchLiveSenseResults({
    surface,
    results: [result(current)],
    lane: lane('mic', { disposition: 'processed', reason: 'processed', updatedAt }),
  })
  assert.equal(attempt('2026-07-13T14:47:01Z'), undefined)
  assert.equal((attempt('2026-07-13T14:47:02Z')?.[0]?.items[0] as SenseLaneSnapshot).disposition, 'processed')
})

test('each live-senses block uses its own hydrated scope authority', () => {
  const secondSurface: Surface = {
    ...surface,
    stack: [surface.stack[0]!, { ...surface.stack[0]!, id: 'second-lanes' }],
  }
  const bound = canonical().map((item) => ({ ...item, workspaceId: 'bound-workspace' })) as SenseLaneSnapshot[]
  const patched = patchLiveSenseResults({
    surface: secondSurface,
    results: [result(canonical()), result(bound)],
    lane: lane('screen', {
      workspaceId: 'bound-workspace',
      disposition: 'delta-skipped',
      reason: 'delta-skipped',
      updatedAt: '2026-07-13T14:47:01Z',
      latestObservation: { id: 'obs', occurredAt: '2026-07-13T14:47:01Z', outcome: 'delta-skipped' },
    }),
  })
  assert.ok(patched)
  assert.equal((patched[0]?.items[2] as SenseLaneSnapshot).disposition, 'waiting')
  assert.equal((patched[1]?.items[2] as SenseLaneSnapshot).disposition, 'delta-skipped')
})

test('refresh reconciliation keeps newer event truth per source but lets a different query scope replace it', () => {
  const current = canonical()
  current[0] = lane('mic', { disposition: 'processed', reason: 'processed', updatedAt: '2026-07-13T14:47:02Z' })
  const olderSnapshot = canonical()
  olderSnapshot[0] = lane('mic', { disposition: 'queued', reason: 'awaiting-processing', updatedAt: '2026-07-13T14:47:01Z' })
  const reconciled = reconcileLiveSenseHydration(surface, [result(current)], [result(olderSnapshot)])
  assert.equal((reconciled[0]?.items[0] as SenseLaneSnapshot).disposition, 'processed')
  assert.equal((reconciled[0]?.items[1] as SenseLaneSnapshot).disposition, 'waiting')

  const nextScope = canonical().map((item) => ({ ...item, sessionId: 'ses-next', disposition: 'waiting' as const }))
  const replaced = reconcileLiveSenseHydration(surface, [result(current)], [result(nextScope)])
  assert.equal((replaced[0]?.items[0] as SenseLaneSnapshot).sessionId, 'ses-next')
  assert.equal((replaced[0]?.items[0] as SenseLaneSnapshot).disposition, 'waiting')
})

test('refresh reconciliation matches sub-trio rows by physical source, and the fresh query owns the shape (#193)', () => {
  const subTrioSurface: Surface = {
    ...surface,
    stack: [{ block: 'sense-lanes', query: { source: 'live-senses', params: { session: 'current' }, top: 2 } }],
  }
  // A newer patched row survives an older re-query snapshot inside a two-lane hydration.
  const current = [lane('mic'), lane('system-audio', { disposition: 'processed', reason: 'processed', updatedAt: '2026-07-13T14:47:02Z' })]
  const older = [lane('mic'), lane('system-audio', { disposition: 'queued', reason: 'awaiting-processing', updatedAt: '2026-07-13T14:47:01Z' })]
  const reconciled = reconcileLiveSenseHydration(subTrioSurface, [result(current)], [result(older)])
  assert.deepEqual(reconciled[0]?.items.map((item) => (item as SenseLaneSnapshot).source), ['mic', 'system-audio'])
  assert.equal((reconciled[0]?.items[1] as SenseLaneSnapshot).disposition, 'processed')

  // A layout edit shrinking the trio between hydrations: per-source truth is kept, but WHICH sources
  // exist follows the fresh query — the dropped lane is not resurrected from the old full-trio cache.
  const fullCurrent = canonical()
  fullCurrent[2] = lane('screen', { disposition: 'processed', reason: 'processed', updatedAt: '2026-07-13T14:47:02Z' })
  const shrunk = reconcileLiveSenseHydration(subTrioSurface, [result(fullCurrent)], [result([lane('mic'), lane('system-audio')])])
  assert.deepEqual(shrunk[0]?.items.map((item) => (item as SenseLaneSnapshot).source), ['mic', 'system-audio'])
})
