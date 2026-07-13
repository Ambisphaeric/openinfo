import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { QueryResult, Surface, TranscriptInspector } from '@openinfo/contracts'
import { renderSurface, renderToHtml, type NowContext } from '../block-renderer/index.js'
import { defaultBlockRegistry } from './index.js'

const now: NowContext = { live: true, workspace: 'acme', title: 'Renewal — security review' }
const result = (items: unknown[]): QueryResult => ({ source: 'transcript', items, truncated: false })

const snapshot = (over: Partial<TranscriptInspector> = {}): TranscriptInspector => ({
  ringLimit: 50,
  sttSlot: [{ endpoint: 'whisper-cpp', model: 'ggml-base.en' }],
  chunks: [
    {
      sessionId: 's-1', source: 'mic', text: 'quarterly numbers look strong', sourceChunkIds: ['mic-s-1-000002'],
      sourceSequenceRange: { start: 2, end: 2 },
      capturedAtRange: { start: '2026-07-07T14:40:00Z', end: '2026-07-07T14:40:03Z' }, processedAt: '2026-07-07T14:40:03.250Z',
    },
    {
      sessionId: 's-1', source: 'system-audio', text: 'can you repeat the renewal date', sourceChunkIds: ['sys-s-1-000001'],
      sourceSequenceRange: { start: 1, end: 1 },
      capturedAtRange: { start: '2026-07-07T14:39:50.000Z', end: '2026-07-07T14:39:50.820Z' }, processedAt: '2026-07-07T14:39:51.000Z',
    },
  ],
  ...over,
})

const surface: Surface = {
  id: 's', name: 's', context: 'meeting', version: 1,
  stack: [
    { block: 'now' },
    { block: 'transcript-inspector', show: 'always', query: { source: 'transcript', params: {} } },
  ],
}

test('the inspector renders each transcript chunk newest-first: clock · stream · duration · raw text', () => {
  const html = renderToHtml(renderSurface({ surface, now, results: [undefined, result([snapshot()])] }, defaultBlockRegistry))
  assert.match(html, /Transcription · inspector/) // the group label
  assert.match(html, /quarterly numbers look strong/) // the raw text (only via result.items)
  assert.match(html, /can you repeat the renewal date/)
  assert.match(html, /Microphone/)
  assert.match(html, /System audio/)
  assert.doesNotMatch(html, /mic · me|sys · them|speaker identity/i)
  assert.match(html, /3\.0s/) // the 3s captured span of the first chunk
  assert.match(html, /820ms/) // the sub-second span of the second chunk renders in ms
})

test('the stt slot is a SEPARATE line — the current config, NOT a per-chunk claim — and the #65 gap is disclosed', () => {
  const html = renderToHtml(renderSurface({ surface, now, results: [undefined, result([snapshot()])] }, defaultBlockRegistry))
  assert.match(html, /stt slot · whisper-cpp · ggml-base\.en/) // the CURRENT slot config, labelled
  assert.match(html, /per-chunk stt provenance is not recorded, #65/) // the honest disclosure — never faked
})

test('an empty stt slot reads "none configured" — honest, not blank', () => {
  const html = renderToHtml(renderSurface({ surface, now, results: [undefined, result([snapshot({ sttSlot: [] })])] }, defaultBlockRegistry))
  assert.match(html, /stt slot · none configured/)
})

test('retention is disclosed: last N, this session, not persisted', () => {
  const html = renderToHtml(renderSurface({ surface, now, results: [undefined, result([snapshot({ ringLimit: 25 })])] }, defaultBlockRegistry))
  assert.match(html, /live feed · last 25, this session, not persisted/)
})

test('an empty ring renders "no transcript chunks yet — start a session", never a blank card', () => {
  const html = renderToHtml(renderSurface({ surface, now, results: [undefined, result([snapshot({ chunks: [] })])] }, defaultBlockRegistry))
  assert.match(html, /Transcription · inspector/) // the block still renders its label + slot line
  assert.match(html, /stt slot · whisper-cpp/)
  assert.match(html, /no transcript chunks yet — start a session/)
})

test('no snapshot at all (the source unwired) stays EXPLAINABLE — not a silent block', () => {
  const html = renderToHtml(renderSurface({ surface, now, results: [undefined, result([])] }, defaultBlockRegistry))
  assert.match(html, /Transcription · inspector/)
  assert.match(html, /Transcription inspector unavailable/)
})

test('top caps the rendered chunk list', () => {
  const many = snapshot({
    chunks: Array.from({ length: 5 }, (_, i) => ({
      sessionId: 's-1', source: 'mic' as const, text: `line ${i}`,
      sourceChunkIds: [`mic-s-1-${i}`],
      sourceSequenceRange: { start: i, end: i },
      capturedAtRange: { start: '2026-07-07T14:40:00Z', end: '2026-07-07T14:40:01Z' },
      processedAt: '2026-07-07T14:40:01.250Z',
    })),
  })
  const capped: Surface = {
    id: 's', name: 's', context: 'meeting', version: 1,
    stack: [{ block: 'now' }, { block: 'transcript-inspector', show: 'always', top: 2, query: { source: 'transcript', params: {} } }],
  }
  const html = renderToHtml(renderSurface({ surface: capped, now, results: [undefined, result([many])] }, defaultBlockRegistry))
  assert.match(html, /line 0/)
  assert.match(html, /line 1/)
  assert.doesNotMatch(html, /line 2/) // capped at top: 2
})
