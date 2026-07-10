import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { QueryResult, Surface } from '@openinfo/contracts'
import { renderSurface, renderToHtml, type NowContext } from '../block-renderer/index.js'
import { defaultBlockRegistry } from './index.js'

const now: NowContext = { live: true, workspace: 'acme', title: 'Renewal — security review' }
const result = (items: unknown[]): QueryResult => ({ source: 'senses', items, truncated: false })

// Structural mirrors of the engine's SenseGateChain/SenseGate (surfaces/settings/sense-gates.ts).
const openChain = {
  sense: 'mic',
  label: 'Microphone',
  gates: [
    { id: 'distill.enabled', label: 'Distill enabled', pass: true },
    { id: 'distill.transcribe', label: 'Transcribe audio', pass: true },
    { id: 'stt', label: 'Hearing (stt) endpoint', pass: true },
  ],
}
const blockedChain = {
  sense: 'screen',
  label: 'Screen',
  gates: [
    { id: 'screen.ocr', label: 'Screen OCR', pass: false, fix: 'Enable “Read the screen” in Settings → Features (screen.ocr).' },
    { id: 'ocr', label: 'Reading (ocr) endpoint', pass: false },
  ],
  blocking: { id: 'screen.ocr', label: 'Screen OCR', pass: false, fix: 'Enable “Read the screen” in Settings → Features (screen.ocr).' },
}

const surface: Surface = {
  id: 's', name: 's', context: 'any', version: 1,
  stack: [
    { block: 'now' },
    { block: 'sense-gates', show: 'always', query: { source: 'senses', params: {} } },
  ],
}

test('an open sense renders all-clear with the whole chain summarized; a blocked sense names the FIRST gate + its fix', () => {
  const html = renderToHtml(renderSurface({ surface, now, results: [undefined, result([openChain, blockedChain])] }, defaultBlockRegistry))
  assert.match(html, /Senses · gates/)
  assert.match(html, /Microphone — engine-side gates open/)
  assert.match(html, /Distill enabled ✓ · Transcribe audio ✓ · Hearing \(stt\) endpoint ✓/)
  assert.match(html, /Screen — blocked: Screen OCR/)
  assert.match(html, /Enable “Read the screen” in Settings → Features/)
})

test('the scope line disclosed: engine-side gates only, health from the last classified failure (no live probe)', () => {
  const html = renderToHtml(renderSurface({ surface, now, results: [undefined, result([openChain])] }, defaultBlockRegistry))
  assert.match(html, /engine-side gates only/)
  assert.match(html, /not a live probe/)
})

test('empty is EXPLAINABLE, never silent: no injected chains renders an unavailable line', () => {
  const html = renderToHtml(renderSurface({ surface, now, results: [undefined, result([])] }, defaultBlockRegistry))
  assert.match(html, /Sense gates unavailable/)
  assert.match(html, /not reporting gate chains/)
})
