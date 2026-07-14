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
  assert.match(html, /raw frames default to device-local/i)
  assert.match(html, /no hosted\/public endpoint/i)
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

test('renderLedger: legacy local provenance does not fabricate device-local scope', () => {
  const passes = buildLedger([distillate({ id: 'd1', createdAt: '2026-07-10T10:00:00Z' })], [])
  const html = renderLedger(withLedger(passes))
  assert.match(html, /no guard/i)
  assert.match(html, /class="ldg-local"[^>]*>local <span class="ldg-model">· scope not recorded/)
  assert.match(html, /guard column \(#63\)/)
})

test('renderLedger: coarse local egress provenance keeps destination scope unknown', () => {
  const passes = buildLedger(
    [
      distillate({
        id: 'coarse-local',
        createdAt: '2026-07-10T10:00:00Z',
        provenance: {
          slot: 'llm',
          endpoint: 'older-local-endpoint',
          egress: {
            reach: 'local',
            allowed: false,
            decidedBy: 'content-class',
            reason: 'network-local destination scope was not recorded',
          },
        },
      }),
    ],
    [],
  )
  const html = renderLedger(withLedger(passes))
  assert.match(html, /local <span class="ldg-model">· scope not recorded/)
  assert.doesNotMatch(html, /<td><span class="ldg-local"[^>]*>device-local/)
})

test('renderLedger: a redacted guard verdict lights up the guard column (span count, never the raw value)', () => {
  const passes = buildLedger(
    [
      distillate({
        id: 'd1',
        createdAt: '2026-07-10T10:00:00Z',
        provenance: {
          slot: 'llm',
          endpoint: 'hosted',
          egress: { reach: 'egress', allowed: true, decidedBy: 'default', reason: 'content left the machine (no layer denied egress)' },
          guard: { behavior: 'redact-and-continue', outcome: 'redacted', guarded: true, maskedSpanCount: 2, spans: [{ kind: 'card-number', start: 0, length: 16 }, { kind: 'email', start: 30, length: 12 }], reason: 'masked 2' },
        },
      }),
    ],
    [],
  )
  const html = renderLedger(withLedger(passes))
  assert.match(html, /redacted · 2/)
  assert.match(html, /class="ldg-egress"/)
})

test('renderLedger: a held egress hop surfaces in the held block with a release/deny affordance', () => {
  const data = withLedger([])
  data.guardHolds = [
    {
      id: 'h1',
      workspaceId: 'default',
      stage: 'distill',
      verdict: { behavior: 'hold-and-surface', outcome: 'held', guarded: true, maskedSpanCount: 1, spans: [{ kind: 'card-number', start: 0, length: 16 }], reason: 'strict mode suspended the hop' },
      status: 'held',
      createdAt: '2026-07-10T10:05:00Z',
    },
  ]
  const html = renderLedger(data)
  assert.match(html, /held by the guard/i)
  assert.match(html, /data-guard-hold="h1"[^>]*data-guard-action="release"/)
  assert.match(html, /data-guard-action="deny"/)
  assert.match(html, /kinds: card-number/)
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
    [distillate({ id: 'd1', createdAt: '2026-07-10T10:00:00Z', provenance: { slot: 'llm', endpoint: 'llm.fast', egress: { reach: 'local', allowed: false, decidedBy: 'content-class', reason: 'stayed on this device: hosted/public denied', destination: 'device-local' } } })],
    [],
  )
  const html = renderLedger(withLedger(passes))
  assert.match(html, /device-local <span class="ldg-model">· content-class/)
})

test('renderLedger: a hop that actually egressed is flagged distinctly and counted in the summary', () => {
  const passes = buildLedger(
    [distillate({ id: 'd1', createdAt: '2026-07-10T10:00:00Z', provenance: { slot: 'llm', endpoint: 'hosted', egress: { reach: 'egress', allowed: true, decidedBy: 'default', reason: 'content left the machine (no layer denied egress)' } } })],
    [],
  )
  const html = renderLedger(withLedger(passes))
  assert.match(html, /class="ldg-egress"[^>]*>hosted\/public</)
  assert.match(html, /<span class="n">1<\/span> device-boundary hop</)
})

test('renderLedger: device-local, explicitly trusted LAN, and hosted/public are visibly distinct', () => {
  const passes = buildLedger(
    [
      distillate({
        id: 'device',
        createdAt: '2026-07-10T10:00:00Z',
        provenance: {
          slot: 'llm',
          endpoint: 'managed',
          egress: {
            reach: 'local',
            allowed: false,
            decidedBy: 'content-class',
            reason: 'stayed on this device',
            destination: 'device-local',
          },
        },
      }),
    ],
    [
      ocr({
        id: 'lan',
        createdAt: '2026-07-10T10:01:00Z',
        provenance: {
          slot: 'ocr',
          endpoint: 'trusted-vision-box',
          egress: {
            reach: 'local',
            allowed: false,
            decidedBy: 'content-class',
            reason: 'raw screen bytes crossed the device boundary to an explicitly trusted LAN destination',
            destination: 'lan-local',
            rawFrameTrust: 'explicit',
          },
        },
      }),
      ocr({
        id: 'hosted',
        createdAt: '2026-07-10T10:02:00Z',
        provenance: {
          slot: 'vlm',
          endpoint: 'hosted-service',
          egress: {
            reach: 'egress',
            allowed: true,
            decidedBy: 'default',
            reason: 'content left the machine for a hosted/public destination',
            destination: 'hosted-public',
          },
        },
      }),
    ],
  )
  const html = renderLedger(withLedger(passes))
  assert.match(html, />device-local <span class="ldg-model">· content-class/)
  assert.match(html, /class="ldg-lan"[^>]*>trusted LAN <span class="ldg-model">· explicit raw-frame trust/)
  assert.match(html, /class="ldg-egress"[^>]*>hosted\/public</)
  assert.match(html, /<span class="n">2<\/span> device-boundary hops/)
  assert.doesNotMatch(html, /<span class="n">0<\/span> device-boundary hops/)
})

// ---------------------------------------------------------------- #116 multi-hop trails

const fieldValue = (over: Partial<import('@openinfo/contracts').FieldValue> & { id: string; updatedAt: string }): import('@openinfo/contracts').FieldValue => ({
  fieldId: 'field-topic',
  workspaceId: 'default',
  sessionId: 'ses-1',
  label: 'Topic',
  value: 'Q3 launch',
  state: 'provisional',
  provenance: { templateId: 'tpl-topic', slot: 'llm', endpoint: 'llm.fast', model: 'tiny-1b' },
  schemaVersion: 1,
  ...over,
})

test('#116 buildLedger: moments join their window pass as ONE aggregated hop (spanId, else distillateId)', () => {
  const moment = (id: string, spanId?: string, distillateId?: string): import('@openinfo/contracts').Moment => ({
    id,
    sessionId: 'ses-1',
    workspaceId: 'default',
    at: '2026-07-10T10:00:01Z',
    kind: 'commitment',
    text: 'ship Thursday',
    refs: [],
    source: 'mic',
    confidence: 0.8,
    ...(spanId !== undefined ? { spanId } : {}),
    provenance: {
      ...(distillateId !== undefined ? { distillateId } : {}),
      slot: 'llm',
      endpoint: 'moment.fallback',
      model: 'extract-3b',
      usage: { estimated: false, promptTokens: 30, completionTokens: 6, totalTokens: 36 },
      egress: { reach: 'local', allowed: true, decidedBy: 'content-class', reason: 'moment extraction stayed on device', destination: 'device-local' },
      guard: { behavior: 'redact-and-continue', outcome: 'clean', guarded: true, maskedSpanCount: 0, guardEndpoint: 'guard-local', reason: 'moment extraction was clean' },
    },
  })
  const passes = buildLedger(
    [distillate({ id: 'd1', createdAt: '2026-07-10T10:00:00Z', spanId: 'span-a' })],
    [],
    { moments: [moment('m1', 'span-a'), moment('m2', 'span-a'), moment('m-other', 'span-z')] },
  )
  assert.equal(passes.length, 1)
  assert.equal(passes[0]!.spanId, 'span-a')
  assert.equal(passes[0]!.hops.length, 2, 'distill hop + one aggregated moments hop')
  const momentsHop = passes[0]!.hops[1]!
  assert.equal(momentsHop.stage, 'moments')
  assert.equal(momentsHop.detail, '2 moments')
  assert.equal(momentsHop.endpoint, 'moment.fallback')
  assert.equal(momentsHop.model, 'extract-3b')
  assert.equal(momentsHop.usage?.totalTokens, 36)
  assert.equal(momentsHop.egress?.destination, 'device-local')
  assert.equal(momentsHop.guard?.outcome, 'clean')

  // Pre-#116 records (no spanId anywhere) still join via the distillateId parent link.
  const legacy = buildLedger(
    [distillate({ id: 'd2', createdAt: '2026-07-10T10:05:00Z' })],
    [],
    { moments: [moment('m3', undefined, 'd2')] },
  )
  assert.equal(legacy[0]!.hops.length, 2)
  assert.equal(legacy[0]!.hops[1]!.detail, '1 moment')
})

test('#116 buildLedger: a field value is a pass whose trail gains a judge hop once reviewed', () => {
  const reviewed = fieldValue({
    id: 'fv-1',
    updatedAt: '2026-07-10T10:01:00Z',
    spanId: 'span-f',
    state: 'corrected',
    provenance: {
      templateId: 'tpl-topic',
      slot: 'llm',
      endpoint: 'llm.fast',
      model: 'tiny-1b',
      usage: { estimated: false, promptTokens: 42, completionTokens: 7 },
      judge: {
        templateId: 'tpl-judge-default',
        endpoint: 'llm.judge',
        model: 'big-32b',
        verdict: 'correct',
        priorValue: 'planning',
        judgedAt: '2026-07-10T10:01:00Z',
        usage: { estimated: false, promptTokens: 300, completionTokens: 40 },
      },
    },
  })
  const passes = buildLedger([], [], { fieldValues: [reviewed] })
  assert.equal(passes.length, 1)
  assert.equal(passes[0]!.spanId, 'span-f')
  assert.deepEqual(passes[0]!.hops.map((h) => h.stage), ['field', 'judge'], 'the dual-input chain is ONE trail')
  assert.equal(passes[0]!.hops[0]!.detail, 'Topic · corrected')
  assert.equal(passes[0]!.hops[0]!.usage?.promptTokens, 42)
  assert.equal(passes[0]!.hops[1]!.endpoint, 'llm.judge')
  assert.equal(passes[0]!.hops[1]!.detail, 'correct')
  assert.equal(passes[0]!.hops[1]!.usage?.promptTokens, 300)

  // Unreviewed ⇒ a single field hop, no fabricated judge hop.
  const unreviewed = buildLedger([], [], { fieldValues: [fieldValue({ id: 'fv-2', updatedAt: '2026-07-10T10:02:00Z' })] })
  assert.deepEqual(unreviewed[0]!.hops.map((h) => h.stage), ['field'])

  // Full version history: provisional + reviewed are ONE causal pass, while a later span reusing the
  // deterministic field id remains a distinct audit pass.
  const first = fieldValue({
    id: 'fv-history', updatedAt: '2026-07-10T10:00:30Z', spanId: 'span-old',
    provenance: { templateId: 'tpl-topic', slot: 'llm', endpoint: 'llm.fast', sourceChunks: ['cap-old'] },
  })
  const firstReviewed = fieldValue({
    ...reviewed,
    id: 'fv-history', updatedAt: '2026-07-10T10:01:00Z', spanId: 'span-old',
    provenance: { ...reviewed.provenance, sourceChunks: ['cap-old'] },
  })
  const later = fieldValue({
    id: 'fv-history', updatedAt: '2026-07-10T10:05:00Z', spanId: 'span-new', value: 'pricing',
    provenance: { templateId: 'tpl-topic', slot: 'llm', endpoint: 'llm.fast', sourceChunks: ['cap-new'] },
  })
  const history = buildLedger([], [], { fieldValues: [first, firstReviewed, later] })
  assert.equal(history.length, 2)
  assert.deepEqual(history.map((pass) => pass.spanId), ['span-new', 'span-old'], 'newest-first audit retains both causal passes')
  assert.deepEqual(history[1]!.hops.map((hop) => hop.stage), ['field', 'judge'], 'same-pass revisions collapse to the judged record')
})

test('#116 buildLedger: a guard hold is a held pass naming the guard endpoint and NO model endpoint', () => {
  const hold: import('@openinfo/contracts').GuardHold = {
    id: 'hold-1',
    workspaceId: 'default',
    sessionId: 'ses-1',
    stage: 'distill',
    spanId: 'span-h',
    sourceChunks: ['c9'],
    verdict: { behavior: 'hold-and-surface', outcome: 'held', guarded: true, maskedSpanCount: 1, spans: [{ kind: 'card-number', start: 0, length: 16 }], guardEndpoint: 'guard-local', reason: 'the egress guard flagged 1 span(s); strict mode suspended the hop for review' },
    status: 'held',
    createdAt: '2026-07-10T10:03:00Z',
  }
  const passes = buildLedger([], [], { guardHolds: [hold] })
  assert.equal(passes.length, 1)
  const hop = passes[0]!.hops[0]!
  assert.equal(hop.stage, 'held')
  assert.equal(hop.slot, 'guard')
  assert.equal(hop.endpoint, 'guard-local', 'the guard endpoint that classified is named')
  assert.equal(hop.guard?.outcome, 'held')

  const html = renderLedger(withLedger(passes))
  assert.match(html, />held</, 'the guard column renders the held outcome')

  // A fail-closed EMPTY-slot hold reached no endpoint at all — the cell says so instead of blanking.
  const noGuard: import('@openinfo/contracts').GuardHold = {
    ...hold,
    id: 'hold-2',
    verdict: { behavior: 'redact-and-continue', outcome: 'held', guarded: false, maskedSpanCount: 0, reason: 'no guard endpoint is configured and unguarded egress is not acknowledged — the hop holds' },
  }
  const html2 = renderLedger(withLedger(buildLedger([], [], { guardHolds: [noGuard] })))
  assert.match(html2, /held before send/, 'no fabricated endpoint for a hop that never reached one')
})

test('#116 buildLedger: without extras the flat behavior is unchanged (the "all passes" view keeps working)', () => {
  const passes = buildLedger([distillate({ id: 'd1', createdAt: '2026-07-10T10:00:00Z' })], [ocr({ id: 'o1', createdAt: '2026-07-10T11:00:00Z' })])
  assert.deepEqual(passes.map((p) => p.id), ['o1', 'd1'])
  assert.deepEqual(passes.flatMap((p) => p.hops.map((h) => h.stage)), ['screen', 'distill'])
})
