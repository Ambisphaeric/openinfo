import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Distillate, OcrResult } from '@openinfo/contracts'
import { buildLedger, renderLedger } from './ledger.js'
import type { SetupData } from '../../setup/view.js'

const distillate = (over: Partial<Distillate> & { id: string; createdAt: string }): Distillate => ({
  sessionId: 'ses-1',
  workspaceId: 'default',
  windowStart: over.createdAt,
  windowEnd: over.createdAt,
  sourceChunks: ['c1'],
  text: 'summary',
  voice: { scope: 'global', dials: { tone: 0, warmth: 0, wit: 0, charm: 0, specificity: 5, brevity: 5 } },
  provenance: { slot: 'llm', endpoint: 'llm.fast' },
  schemaVersion: 1,
  ...over,
})

const ocr = (over: Partial<OcrResult> & { id: string; createdAt: string }): OcrResult => ({
  sessionId: 'ses-1',
  workspaceId: 'default',
  sourceChunks: ['f1'],
  text: 'on screen',
  provenance: { slot: 'ocr', endpoint: 'ocr.paddle' },
  schemaVersion: 1,
  ...over,
})

// minimal SetupData for the render tests — only `ledger` is read by renderLedger
const withLedger = (ledger: SetupData['ledger']): SetupData =>
  ({ ledger } as unknown as SetupData)

test('buildLedger: an llm distillate becomes a distill pass with a single hop', () => {
  const passes = buildLedger([distillate({ id: 'd1', createdAt: '2026-07-10T10:00:00Z', provenance: { slot: 'llm', endpoint: 'llm.fast', model: 'llama', usage: { estimated: false, promptTokens: 210, completionTokens: 34, totalTokens: 244, durationMs: 600 } } })], [])
  assert.equal(passes.length, 1)
  assert.equal(passes[0]!.hops.length, 1)
  const hop = passes[0]!.hops[0]!
  assert.equal(hop.stage, 'distill')
  assert.equal(hop.endpoint, 'llm.fast')
  assert.equal(hop.model, 'llama')
  assert.equal(hop.usage?.promptTokens, 210)
})

test('buildLedger: an OcrResult becomes a screen pass; its MIRROR ocr/vlm distillate is NOT double-counted', () => {
  // the screen path persists BOTH an OcrResult and a mirror distillate with slot 'ocr'
  const passes = buildLedger(
    [distillate({ id: 'mirror', createdAt: '2026-07-10T10:00:00Z', provenance: { slot: 'ocr', endpoint: 'ocr.paddle' } })],
    [ocr({ id: 'o1', createdAt: '2026-07-10T10:00:00Z' })],
  )
  assert.equal(passes.length, 1, 'only the OcrResult counts as a screen pass; the mirror distillate is skipped')
  assert.equal(passes[0]!.id, 'o1')
  assert.equal(passes[0]!.hops[0]!.stage, 'screen')
})

test('buildLedger: passes are newest-first', () => {
  const passes = buildLedger(
    [
      distillate({ id: 'old', createdAt: '2026-07-10T09:00:00Z' }),
      distillate({ id: 'new', createdAt: '2026-07-10T11:00:00Z' }),
    ],
    [ocr({ id: 'mid', createdAt: '2026-07-10T10:00:00Z' })],
  )
  assert.deepEqual(passes.map((p) => p.id), ['new', 'mid', 'old'])
})

test('renderLedger: empty state is an honest card, never blank', () => {
  const html = renderLedger(withLedger([]))
  assert.match(html, /No passes recorded yet/)
  assert.match(html, /nothing can leave/i) // the honest egress disclosure (#64) still shows in the footer
})

test('renderLedger: a measured pass renders endpoint, tokens, and NO est marker', () => {
  const passes = buildLedger([distillate({ id: 'd1', createdAt: '2026-07-10T10:00:00Z', provenance: { slot: 'llm', endpoint: 'llm.fast', model: 'llama', usage: { estimated: false, promptTokens: 210, completionTokens: 34, totalTokens: 244 } } })], [])
  const html = renderLedger(withLedger(passes))
  assert.match(html, /llm\.fast/)
  assert.match(html, /210 in · 34 out/)
  // the summary must NOT flag estimation for an all-measured ledger (the footer legend mentions "est" always)
  assert.doesNotMatch(html, /some estimated/)
})

test('renderLedger: an estimated pass is MARKED est (a measurement is never impersonated)', () => {
  const passes = buildLedger([distillate({ id: 'd1', createdAt: '2026-07-10T10:00:00Z', provenance: { slot: 'llm', endpoint: 'llm.fast', usage: { estimated: true, promptTokens: 5, completionTokens: 2, totalTokens: 7 } } })], [])
  const html = renderLedger(withLedger(passes))
  assert.match(html, /class="ldg-est">est</)
  assert.match(html, /some estimated/)
})

test('renderLedger: guard stays an honest absence; a pre-#64 record with no egress decision renders the local default', () => {
  const passes = buildLedger([distillate({ id: 'd1', createdAt: '2026-07-10T10:00:00Z' })], [])
  const html = renderLedger(withLedger(passes))
  assert.match(html, /no guard/i)
  assert.match(html, /class="ldg-local"[^>]*>local</)
  assert.match(html, /Guard verdicts \(#63\)/)
})

test('buildLedger: carries the recorded egress decision onto the hop', () => {
  const passes = buildLedger(
    [distillate({ id: 'd1', createdAt: '2026-07-10T10:00:00Z', provenance: { slot: 'llm', endpoint: 'llm.fast', egress: { reach: 'local', allowed: false, decidedBy: 'workspace', reason: 'stayed local: this workspace denies egress' } } })],
    [],
  )
  assert.equal(passes[0]?.hops[0]?.egress?.decidedBy, 'workspace')
})

test('renderLedger: a stayed-local-by-policy hop shows the deciding layer', () => {
  const passes = buildLedger(
    [distillate({ id: 'd1', createdAt: '2026-07-10T10:00:00Z', provenance: { slot: 'llm', endpoint: 'llm.fast', egress: { reach: 'local', allowed: false, decidedBy: 'content-class', reason: 'stayed local: screen-derived content never leaves the machine' } } })],
    [],
  )
  const html = renderLedger(withLedger(passes))
  assert.match(html, /local <span class="ldg-model">· content-class/)
})

test('renderLedger: a hop that actually egressed is flagged distinctly and counted in the summary', () => {
  const passes = buildLedger(
    [distillate({ id: 'd1', createdAt: '2026-07-10T10:00:00Z', provenance: { slot: 'llm', endpoint: 'hosted', egress: { reach: 'egress', allowed: true, decidedBy: 'default', reason: 'content left the machine (no layer denied egress)' } } })],
    [],
  )
  const html = renderLedger(withLedger(passes))
  assert.match(html, /class="ldg-egress"[^>]*>egress</)
  assert.match(html, /<span class="n">1<\/span> egress hop</)
})
