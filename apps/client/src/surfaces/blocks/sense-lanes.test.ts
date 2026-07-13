import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { QueryResult, SenseLaneDisposition, SenseLaneSnapshot, Surface } from '@openinfo/contracts'
import { renderSurface, renderToHtml, type NowContext } from '../block-renderer/index.js'
import { defaultBlockRegistry } from './index.js'

process.env.TZ = 'UTC'

const now: NowContext = { live: true, workspace: 'acme', title: 'Design review' }
const surface: Surface = {
  id: 's',
  name: 's',
  context: 'meeting',
  version: 1,
  stack: [{ block: 'sense-lanes', show: 'always', query: { source: 'live-senses', params: { session: 'current' } } }],
}

const lane = <Source extends SenseLaneSnapshot['source']>(
  source: Source,
  disposition: SenseLaneDisposition,
): Extract<SenseLaneSnapshot, { source: Source }> => ({
  workspaceId: 'acme',
  sessionId: 'ses-live',
  source,
  disposition,
  health: disposition === 'failed' ? 'failed' : disposition === 'stopped' ? 'unknown' : 'healthy',
  reason: disposition === 'stopped'
    ? 'session-ended'
    : disposition === 'waiting'
      ? 'awaiting-capture'
      : disposition === 'queued'
        ? 'awaiting-processing'
        : disposition === 'processed'
          ? 'processed'
          : disposition === 'delta-skipped'
            ? 'delta-skipped'
            : disposition === 'blank'
              ? 'blank'
              : 'processing-failed',
  updatedAt: '2026-07-13T14:47:00Z',
}) as Extract<SenseLaneSnapshot, { source: Source }>

const result = (items: SenseLaneSnapshot[]): QueryResult => ({ source: 'live-senses', items, truncated: false })
const render = (items: SenseLaneSnapshot[]): string =>
  renderToHtml(renderSurface({ surface, now, results: [result(items)] }, defaultBlockRegistry))

test('the live-sense block always renders mic, system audio, and screen in canonical order with fixed labels', () => {
  const html = render([
    lane('screen', 'delta-skipped'),
    lane('mic', 'waiting'),
    lane('system-audio', 'queued'),
  ])
  assert.ok(html.indexOf('Microphone') < html.indexOf('System audio'))
  assert.ok(html.indexOf('System audio') < html.indexOf('Screen'))
  assert.match(html, /data-sense-source="mic"/)
  assert.match(html, /data-sense-source="system-audio"/)
  assert.match(html, /data-sense-source="screen"/)
  assert.doesNotMatch(html, /me|them|speaker/i)
})

test('every closed disposition has deliberate human copy', () => {
  const expected: Record<SenseLaneDisposition, string> = {
    stopped: 'Stopped',
    waiting: 'Waiting',
    queued: 'Queued',
    processed: 'Processed',
    'delta-skipped': 'No screen change',
    blank: 'No content found',
    failed: 'Failed',
  }
  for (const [disposition, label] of Object.entries(expected) as Array<[SenseLaneDisposition, string]>) {
    assert.match(render([lane('mic', disposition)]), new RegExp(`Microphone · ${label}`))
  }
})

test('capture freshness, correlated processing outcome and lag, and screen attempt outcome are visible', () => {
  const mic: SenseLaneSnapshot = {
    ...lane('mic', 'processed'),
    latestCapture: { id: 'capture-secret-1', capturedAt: '2026-07-13T14:46:58Z' },
    latestProcessing: {
      captureId: 'capture-secret-1',
      capturedAt: '2026-07-13T14:46:58Z',
      completedAt: '2026-07-13T14:46:59.240Z',
      outcome: 'processed',
      lagMs: 1240,
      basis: 'capture-to-processing-completion',
    },
  }
  const screen: SenseLaneSnapshot = {
    ...lane('screen', 'delta-skipped'),
    latestObservation: { id: 'observation-secret-1', occurredAt: '2026-07-13T14:47:00Z', outcome: 'delta-skipped' },
  }
  const html = render([mic, lane('system-audio', 'blank'), screen])
  assert.match(html, /Last captured 2:46p/)
  assert.match(html, /Processing complete in 1.2 s/)
  assert.match(html, /No screen change observed 2:47p/)

  const failedScreen: SenseLaneSnapshot = {
    ...lane('screen', 'failed'),
    latestObservation: { id: 'observation-secret-2', occurredAt: '2026-07-13T14:47:00Z', outcome: 'grab-failed' },
  }
  assert.match(render([failedScreen]), /Screen capture failed 2:47p/)
})

test('the glance copy never exposes correlation ids, captured content, endpoints, models, or arbitrary errors', () => {
  const failed: SenseLaneSnapshot = {
    ...lane('mic', 'failed'),
    latestCapture: { id: 'capture-secret-1', capturedAt: '2026-07-13T14:46:58Z' },
    latestProcessing: {
      captureId: 'capture-secret-1',
      capturedAt: '2026-07-13T14:46:58Z',
      completedAt: '2026-07-13T14:46:59Z',
      outcome: 'failed',
      lagMs: 1000,
      basis: 'capture-to-processing-completion',
    },
  }
  const failedHtml = render([failed])
  assert.match(failedHtml, /Microphone · Failed · Needs attention/)
  assert.match(failedHtml, /Processing failed in 1 s/)
  assert.doesNotMatch(failedHtml, /capture-secret-1/)

  const unsafe = {
    ...failed,
    text: 'raw words must stay private',
    media: 'base64-private-pixels',
    endpoint: 'lint-endpoint-x',
    model: 'lint-model-9b',
    error: 'stack trace from a private host',
  } as unknown as SenseLaneSnapshot
  const html = render([unsafe])
  assert.match(html, /Microphone · Status unavailable/)
  for (const secret of ['capture-secret-1', 'raw words', 'base64-private-pixels', 'lint-endpoint-x', 'lint-model-9b', 'stack trace']) {
    assert.doesNotMatch(html, new RegExp(secret))
  }
  assert.doesNotMatch(html, /[–—]/)
})

test('invented disposition or health values in initial hydration degrade safely instead of crashing', () => {
  for (const invalid of [
    { ...lane('mic', 'waiting'), disposition: 'invented-disposition' },
    { ...lane('mic', 'waiting'), health: 'invented-health' },
  ]) {
    assert.doesNotThrow(() => render([invalid as unknown as SenseLaneSnapshot]))
    assert.match(render([invalid as unknown as SenseLaneSnapshot]), /Microphone · Status unavailable/)
  }
})

test('missing hydration stays explainable and collapsed mode stays compact', () => {
  const html = render([])
  assert.equal((html.match(/Status unavailable/g) ?? []).length, 3)
  assert.equal((html.match(/Waiting for a live snapshot/g) ?? []).length, 3)

  const collapsed: Surface = { ...surface, stack: [{ ...surface.stack[0]!, collapsed: true }] }
  const collapsedHtml = renderToHtml(renderSurface({ surface: collapsed, now, results: [result([])] }, defaultBlockRegistry))
  assert.match(collapsedHtml, /Live senses/)
  assert.doesNotMatch(collapsedHtml, /sense-lane/)
})
