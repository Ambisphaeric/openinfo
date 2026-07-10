import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { OcrResult } from '@openinfo/contracts'
import { correlate, correlateWindow, ocrForms, ocrTextForms, overlapsWindow, DEFAULT_CORRELATION_CONFIG } from './correlate.js'

// A canned same-window OCR result: the repo open in a browser (scenario 5's screen line).
const ocrResult = (over: Partial<OcrResult> = {}): OcrResult => ({
  id: 'ocr-1',
  sessionId: 'ses-1',
  workspaceId: 'ws-1',
  sourceChunks: ['frame-1'],
  text: 'acme/pi.dev · Pull requests · #218 retry backoff',
  provenance: { slot: 'ocr', endpoint: 'ocr.local' },
  schemaVersion: 1,
  createdAt: '2026-07-07T14:00:05Z',
  capturedAt: '2026-07-07T14:00:04Z',
  ...over,
})

const WINDOW = { start: '2026-07-07T14:00:00Z', end: '2026-07-07T14:00:08Z' }

test('overlapsWindow: in-window true, adjacent-outside false, non-finite false', () => {
  const w = DEFAULT_CORRELATION_CONFIG.windowMs
  // squarely inside the interval
  assert.equal(overlapsWindow('2026-07-07T14:00:04Z', WINDOW.start, WINDOW.end, w), true)
  // just past the end + slack (8s window ends 14:00:08, + 8s slack = 14:00:16) → 30s out is false
  assert.equal(overlapsWindow('2026-07-07T14:00:46Z', WINDOW.start, WINDOW.end, w), false)
  // within the slack band past the end is still in-window
  assert.equal(overlapsWindow('2026-07-07T14:00:12Z', WINDOW.start, WINDOW.end, w), true)
  // an unparseable timestamp never fabricates proximity
  assert.equal(overlapsWindow('not-a-date', WINDOW.start, WINDOW.end, w), false)
})

test('ocrTextForms splits a line into segments and path components', () => {
  const forms = ocrTextForms('acme/pi.dev · Pull requests · #218 retry backoff')
  assert.ok(forms.includes('acme/pi.dev'))
  assert.ok(forms.includes('pi.dev')) // split on "/" — the form that matches the heard "pie dev"
  assert.ok(forms.includes('Pull requests'))
})

test('ocrForms dedups across blocks + text by normalized form', () => {
  const forms = ocrForms(ocrResult({ blocks: [{ text: 'pi.dev' }, { text: 'pi.dev' }] }))
  const piDev = forms.filter((f) => f.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === 'pi dev')
  assert.equal(piDev.length, 1)
})

test('correlate: heard mangle matches an OCR form above threshold (heard + seen)', () => {
  const result = correlate({ name: 'pie dev' }, ocrForms(ocrResult()))
  assert.equal(result.corroborated, true)
  assert.ok(result.similarity >= DEFAULT_CORRELATION_CONFIG.matchThreshold)
  assert.equal(result.matchedForm, 'pi.dev')
  assert.equal(result.multiplier, DEFAULT_CORRELATION_CONFIG.boost)
})

test('correlate: unrelated on-screen text does not corroborate (seen-only → neutral)', () => {
  const result = correlate({ name: 'pie dev' }, ocrForms(ocrResult({ text: 'Weather · 72°F · Cupertino' })))
  assert.equal(result.corroborated, false)
  assert.equal(result.multiplier, 1)
  assert.equal(result.matchedForm, undefined)
})

test('correlateWindow: heard-only (no OCR) is neutral, no sighting', () => {
  const corr = correlateWindow({ heard: { name: 'pie dev' }, window: WINDOW, ocr: [] })
  assert.equal(corr.corroborated, false)
  assert.equal(corr.multiplier, 1)
  assert.equal(corr.sighting, undefined)
})

test('correlateWindow: heard + seen in the SAME window boosts and emits a seen sighting', () => {
  const corr = correlateWindow({ heard: { name: 'pie dev' }, window: WINDOW, ocr: [ocrResult()] })
  assert.equal(corr.corroborated, true)
  assert.equal(corr.multiplier, DEFAULT_CORRELATION_CONFIG.boost)
  assert.ok(corr.sighting)
  assert.equal(corr.sighting?.via, 'seen')
  assert.equal(corr.sighting?.at, '2026-07-07T14:00:04Z') // the OCR capture instant
  assert.equal(corr.sighting?.detail, 'pi.dev') // the matched on-screen form (evidence)
})

test('correlateWindow: heard + seen ADJACENT but outside the window → no boost', () => {
  // OCR captured ~2 minutes after the window ends — well past the ± slack.
  const late = ocrResult({ capturedAt: '2026-07-07T14:02:04Z', createdAt: '2026-07-07T14:02:05Z' })
  const corr = correlateWindow({ heard: { name: 'pie dev' }, window: WINDOW, ocr: [late] })
  assert.equal(corr.corroborated, false)
  assert.equal(corr.multiplier, 1)
  assert.equal(corr.sighting, undefined)
})

test('correlateWindow: falls back to createdAt when capturedAt is absent', () => {
  const noCapture: OcrResult = {
    id: 'ocr-2', sessionId: 'ses-1', workspaceId: 'ws-1', sourceChunks: ['frame-2'],
    text: 'acme/pi.dev · Pull requests',
    provenance: { slot: 'ocr', endpoint: 'ocr.local' }, schemaVersion: 1, createdAt: '2026-07-07T14:00:05Z',
  }
  const corr = correlateWindow({ heard: { name: 'pie dev' }, window: WINDOW, ocr: [noCapture] })
  assert.equal(corr.corroborated, true)
  assert.equal(corr.sighting?.at, '2026-07-07T14:00:05Z') // createdAt
})
