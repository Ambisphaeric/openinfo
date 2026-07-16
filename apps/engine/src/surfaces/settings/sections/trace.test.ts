import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Distillate, FieldValue, GuardHold, Moment, OcrResult, SttSegment } from '@openinfo/contracts'
import { buildTrace, buildTraceInputs, renderTrace, type TraceData, type TraceRecords } from './trace.js'
import type { SetupData } from '../../setup/view.js'

/**
 * The Trace section (#116), proven headless on deterministic fixture records: the full utterance walk
 * (heard → summary → moment → field → judge), the guard-hold branch, the capture walk, and every honest
 * state (empty, unknown selection, no downstream yet, failed assembly). The served path is driven end to
 * end in api/trace-e2e.test.ts; these fix the builder/render semantics.
 */

const segment = (over: Partial<SttSegment> = {}): SttSegment => ({
  id: 'seg-1',
  workspaceId: 'default',
  sessionId: 'ses-1',
  chunkId: 'cap-1',
  spanId: 'span-stt',
  source: 'mic',
  capturedAt: '2026-07-12T12:00:00.000Z',
  processedAt: '2026-07-12T12:00:01.000Z',
  textChars: 118,
  provenance: {
    slot: 'stt',
    endpoint: 'whisper-box',
    model: 'whisper-large-v3',
    durationMs: 940,
    egress: { reach: 'local', allowed: true, decidedBy: 'content-class', reason: 'audio stayed on device', destination: 'device-local' },
  },
  schemaVersion: 1,
  createdAt: '2026-07-12T12:00:01.000Z',
  ...over,
})

const distillate = (over: Partial<Distillate> = {}): Distillate => ({
  id: 'd-1',
  sessionId: 'ses-1',
  workspaceId: 'default',
  windowStart: '2026-07-12T12:00:00.000Z',
  windowEnd: '2026-07-12T12:00:15.000Z',
  sourceChunks: ['cap-1'],
  spanId: 'span-window',
  text: 'They agreed to ship Thursday.',
  voice: { scope: 'global', dials: { tone: 0, warmth: 0, wit: 0, charm: 0, specificity: 5, brevity: 5 } },
  provenance: {
    slot: 'llm',
    endpoint: 'llm.fast',
    model: 'qwen3-8b',
    usage: { estimated: false, promptTokens: 210, completionTokens: 34, durationMs: 600 },
    egress: { reach: 'local', allowed: true, decidedBy: 'content-class', reason: 'transcript-class content resolved to a local endpoint', destination: 'device-local' },
    guard: { behavior: 'redact-and-continue', outcome: 'clean', guarded: true, maskedSpanCount: 0, guardEndpoint: 'guard-local', reason: 'the egress guard ran and flagged nothing' },
  },
  schemaVersion: 1,
  createdAt: '2026-07-12T12:00:16.000Z',
  ...over,
})

const moment = (over: Partial<Moment> = {}): Moment => ({
  id: 'm-1',
  sessionId: 'ses-1',
  workspaceId: 'default',
  // A Moment.at is the event/material time (windowEnd), so it truthfully predates summary.createdAt.
  at: '2026-07-12T12:00:15.000Z',
  kind: 'commitment',
  text: 'ship Thursday',
  refs: [],
  source: 'mic',
  confidence: 0.85,
  spanId: 'span-window',
  provenance: {
    distillateId: 'd-1',
    slot: 'llm',
    endpoint: 'moment.local',
    model: 'extract-3b',
    usage: { estimated: false, promptTokens: 120, completionTokens: 18, totalTokens: 138, durationMs: 410 },
    egress: { reach: 'local', allowed: true, decidedBy: 'content-class', reason: 'moment extraction stayed on device', destination: 'device-local' },
    guard: { behavior: 'redact-and-continue', outcome: 'clean', guarded: true, maskedSpanCount: 0, guardEndpoint: 'guard-local', reason: 'moment extraction was clean' },
  },
  ...over,
})

const fieldValue = (over: Partial<FieldValue> = {}): FieldValue => ({
  id: 'fv:default:ses-1:field-topic',
  fieldId: 'field-topic',
  workspaceId: 'default',
  sessionId: 'ses-1',
  label: 'Topic',
  value: 'Q3 launch sequencing',
  state: 'corrected',
  spanId: 'span-fields',
  provenance: {
    templateId: 'tpl-topic',
    slot: 'llm',
    endpoint: 'llm.fast',
    model: 'tiny-1b',
    sourceChunks: ['cap-1'],
    judge: {
      templateId: 'tpl-judge-default',
      endpoint: 'llm.judge',
      model: 'big-32b',
      verdict: 'correct',
      priorValue: 'planning',
      note: 'fast tier was too generic',
      judgedAt: '2026-07-12T12:01:00.000Z',
      spanId: 'span-judge',
    },
  },
  updatedAt: '2026-07-12T12:01:00.000Z',
  schemaVersion: 1,
  ...over,
})

const capture = (over: Partial<OcrResult> = {}): OcrResult => ({
  id: 'ocr-1',
  sessionId: 'ses-1',
  workspaceId: 'default',
  sourceChunks: ['frame-1'],
  spanId: 'span-screen',
  text: 'Q3 Launch Plan — Board Review.pdf',
  provenance: {
    slot: 'ocr',
    endpoint: 'ocr.paddle',
    egress: { reach: 'local', allowed: true, decidedBy: 'content-class', reason: 'raw frame stayed on device', destination: 'device-local' },
  },
  schemaVersion: 1,
  createdAt: '2026-07-12T12:02:00.000Z',
  capturedAt: '2026-07-12T12:01:58.000Z',
  ...over,
})

const records = (over: Partial<TraceRecords> = {}): TraceRecords => ({
  sttSegments: [segment()],
  distillates: [distillate()],
  moments: [moment()],
  fieldValues: [fieldValue()],
  guardHolds: [],
  ocrResults: [],
  ...over,
})

const setup = (trace: TraceData | undefined): SetupData => ({ trace } as unknown as SetupData)

test('buildTraceInputs: utterances and captures, newest first, with human labels (size, never content)', () => {
  const inputs = buildTraceInputs(records({ ocrResults: [capture()] }))
  assert.deepEqual(inputs.map((i) => i.id), ['ocr-1', 'seg-1'], 'newest first across kinds')
  assert.equal(inputs[1]!.kind, 'utterance')
  assert.equal(inputs[1]!.label, 'Microphone · 118 characters heard')
  assert.match(inputs[1]!.meta, /whisper-box · whisper-large-v3 · 940ms/)
  assert.equal(inputs[1]!.egress?.destination, 'device-local', 'the STT root retains its own destination truth')
  assert.equal(inputs[0]!.kind, 'capture')
  assert.match(inputs[0]!.label, /Screen · 33 characters recognized/)
})

test('buildTrace: an utterance walks heard → summary → moment → field → judge on persisted links only', () => {
  const trail = buildTrace('seg-1', records())!
  assert.ok(trail !== undefined)
  assert.equal(trail.input.kind, 'utterance')
  assert.deepEqual(
    trail.hops.map((h) => h.stage),
    ['summary', 'moment', 'field', 'judge'],
    'causal links win over incomparable times: summary.createdAt follows moment.at, but the parent renders first',
  )
  const [summary, m, field, judge] = trail.hops
  assert.equal(summary!.body, 'They agreed to ship Thursday.')
  assert.equal(summary!.guard?.outcome, 'clean')
  assert.equal(summary!.egress?.destination, 'device-local')
  assert.equal(m!.title, 'Noted a commitment')
  assert.match(m!.meta!, /moment\.local · extract-3b · 410ms/)
  assert.equal(m!.usage?.totalTokens, 138)
  assert.equal(m!.guard?.outcome, 'clean')
  assert.equal(m!.egress?.destination, 'device-local')
  assert.equal(field!.title, 'Field “Topic” updated · corrected')
  assert.equal(judge!.title, 'Judge corrected it')
  assert.match(judge!.body!, /was “planning”/, 'what changed is inspectable')
})

test('buildTrace: multiple windows stay parent-grouped when material and processing clocks cross', () => {
  const firstWindow = distillate({ id: 'd-a', spanId: 'span-a', text: 'summary A', createdAt: '2026-07-12T12:00:20.000Z' })
  const secondWindow = distillate({ id: 'd-b', spanId: 'span-b', text: 'summary B', createdAt: '2026-07-12T12:00:30.000Z' })
  const firstMoment = moment({
    id: 'm-a', spanId: 'span-a', text: 'moment A', at: '2026-07-12T12:10:00.000Z',
    provenance: { distillateId: 'd-a', slot: 'llm', endpoint: 'moment-a' },
  })
  const secondMoment = moment({
    id: 'm-b', spanId: 'span-b', text: 'moment B', at: '2026-07-12T11:50:00.000Z',
    provenance: { distillateId: 'd-b', slot: 'llm', endpoint: 'moment-b' },
  })
  const trail = buildTrace(
    'seg-1',
    records({ distillates: [secondWindow, firstWindow], moments: [secondMoment, firstMoment], fieldValues: [], guardHolds: [] }),
  )!

  assert.deepEqual(
    trail.hops.map((hop) => hop.body),
    ['summary A', 'moment A', 'summary B', 'moment B'],
    'each parent summary precedes its child; incomparable Moment.at values never globally reorder branches',
  )
})

test('buildTrace: a chunk NOT in a record’s sourceChunks never joins — no fuzzy time matching', () => {
  const other = records({
    distillates: [distillate({ sourceChunks: ['cap-OTHER'] })],
    fieldValues: [fieldValue({ provenance: { ...fieldValue().provenance, sourceChunks: ['cap-OTHER'] } })],
    moments: [],
  })
  const trail = buildTrace('seg-1', other)!
  assert.deepEqual(trail.hops, [], 'same session + overlapping times, but no persisted link ⇒ no hop')
})

test('buildTrace: matching chunk/span ids in another workspace or session never splice into the selected trail', () => {
  const good = distillate({ id: 'd-good', text: 'same-session summary' })
  const badSession = distillate({ id: 'd-bad-session', sessionId: 'ses-2', text: 'other-session summary' })
  const badWorkspace = distillate({ id: 'd-bad-workspace', workspaceId: 'other', text: 'other-workspace summary' })
  const alienMoment = moment({
    id: 'm-alien', sessionId: 'ses-2', spanId: 'span-window', text: 'other-session moment',
    provenance: { distillateId: good.id, slot: 'llm', endpoint: 'alien-moment' },
  })
  const alienField = fieldValue({
    id: 'fv:default:ses-2:field-topic', sessionId: 'ses-2', value: 'other-session field',
  })
  const alienHold: GuardHold = {
    id: 'hold-alien', workspaceId: 'default', sessionId: 'ses-2', stage: 'distill', sourceChunks: ['cap-1'],
    verdict: { behavior: 'hold-and-surface', outcome: 'held', guarded: true, maskedSpanCount: 0, reason: 'other session' },
    status: 'held', createdAt: '2026-07-12T12:00:19.000Z',
  }
  const trail = buildTrace(
    'seg-1',
    records({
      distillates: [badSession, good, badWorkspace], moments: [alienMoment], fieldValues: [alienField], guardHolds: [alienHold],
    }),
  )!

  assert.deepEqual(trail.hops.map((hop) => hop.body), ['same-session summary'])
})

test('buildTrace: a distill hold precedes field/review branches and truthfully describes release', () => {
  const hold: GuardHold = {
    id: 'hold-1',
    workspaceId: 'default',
    sessionId: 'ses-1',
    stage: 'distill',
    spanId: 'span-held',
    sourceChunks: ['cap-1'],
    verdict: { behavior: 'hold-and-surface', outcome: 'held', guarded: true, maskedSpanCount: 1, spans: [{ kind: 'card-number', start: 0, length: 16 }], guardEndpoint: 'guard-local', reason: 'the egress guard flagged 1 span(s); strict mode suspended the hop for review' },
    status: 'held',
    createdAt: '2026-07-12T12:00:20.000Z',
  }
  const trail = buildTrace('seg-1', records({ distillates: [], moments: [], fieldValues: [fieldValue()], guardHolds: [hold] }))!
  assert.deepEqual(trail.hops.map((h) => h.stage), ['held', 'field', 'judge'], 'distill hold is a sibling before the later field/review stages')
  assert.match(trail.hops[0]!.title, /target model was not called/i)
  assert.equal(trail.hops[0]!.guard?.outcome, 'held')

  const released: GuardHold = { ...hold, status: 'released', resolvedAt: '2026-07-12T12:05:00.000Z' }
  const releasedTrail = buildTrace('seg-1', records({ distillates: [], moments: [], fieldValues: [], guardHolds: [released] }))!
  assert.match(releasedTrail.hops[0]!.title, /approval recorded/i)
  assert.match(releasedTrail.hops[0]!.title, /original held pass was not rerun/i)
  assert.doesNotMatch(releasedTrail.hops[0]!.title, /then released/i)
})

test('buildTrace: a post-delivery target failure never claims the request was blocked before target', () => {
  const hold = {
    id: 'hold-delivery', workspaceId: 'default', sessionId: 'ses-1', stage: 'distill', sourceChunks: ['cap-1'],
    verdict: { behavior: 'hold-and-surface', outcome: 'held', guarded: true, maskedSpanCount: 0, reason: 'fallback suspended after target failure' },
    status: 'held', createdAt: '2026-07-12T12:00:20.000Z',
    target: { endpoint: 'hosted-primary', model: 'large-1', destination: 'hosted-public', delivery: 'confirmed', failureClass: 'http-500' },
  } as unknown as GuardHold
  const r = records({ distillates: [], moments: [], fieldValues: [], guardHolds: [hold] })
  const trail = buildTrace('seg-1', r)!
  assert.match(trail.hops[0]!.title, /Target received the request but failed/)
  assert.doesNotMatch(trail.hops[0]!.title, /target model was not called/i)
  const html = renderTrace(setup({ inputs: buildTraceInputs(r), selectedId: 'seg-1', trail }))
  assert.match(html, /target attempted · fallback blocked/)
  assert.doesNotMatch(html, /blocked before target/)
})

test('buildTrace: a capture input walks to its recognized text; an unknown id returns undefined', () => {
  const trail = buildTrace('ocr-1', records({ ocrResults: [capture()] }))!
  assert.equal(trail.input.kind, 'capture')
  assert.deepEqual(trail.hops.map((h) => h.stage), ['seen'])
  assert.equal(trail.hops[0]!.body, 'Q3 Launch Plan — Board Review.pdf')

  assert.equal(buildTrace('nope', records()), undefined)
})

test('buildTrace: a screen input follows its shared-span mirror through summary, moment, field, judge, and hold', () => {
  const mirror = distillate({
    id: 'd-screen',
    sourceChunks: ['frame-1'],
    spanId: 'span-screen',
    text: 'Q3 Launch Plan — Board Review.pdf',
    windowStart: '2026-07-12T12:01:58.000Z',
    windowEnd: '2026-07-12T12:01:58.000Z',
    createdAt: '2026-07-12T12:02:00.000Z',
    provenance: capture().provenance,
  })
  const screenMoment = moment({
    id: 'm-screen',
    source: 'screen',
    spanId: 'span-screen',
    at: '2026-07-12T12:01:58.000Z',
    text: 'board review deck shown',
    provenance: { distillateId: 'd-screen', slot: 'llm', endpoint: 'moment.local', model: 'extract-3b' },
  })
  const screenField = fieldValue({
    spanId: 'span-screen-field',
    provenance: { ...fieldValue().provenance, sourceChunks: ['frame-1'] },
  })
  const hold: GuardHold = {
    id: 'hold-screen',
    workspaceId: 'default',
    sessionId: 'ses-1',
    stage: 'distill',
    spanId: 'span-screen-hold',
    sourceChunks: ['frame-1'],
    verdict: {
      behavior: 'hold-and-surface',
      outcome: 'held',
      guarded: true,
      maskedSpanCount: 1,
      spans: [{ kind: 'card-number', start: 0, length: 16 }],
      guardEndpoint: 'guard-local',
      reason: 'screen-derived hop held before send',
    },
    status: 'held',
    createdAt: '2026-07-12T12:02:10.000Z',
  }
  const spanlessLegacy = distillate({ ...mirror, id: 'd-screen-legacy', text: 'legacy fallback must lose to exact span' })
  delete spanlessLegacy.spanId
  const otherSessionExact = distillate({ ...mirror, id: 'd-screen-other-session', sessionId: 'ses-2', text: 'other session must not join' })
  const trail = buildTrace(
    'ocr-1',
    records({
      ocrResults: [capture()],
      distillates: [spanlessLegacy, mirror, mirror, otherSessionExact],
      moments: [screenMoment], fieldValues: [screenField], guardHolds: [hold],
    }),
  )!

  assert.deepEqual(trail.hops.map((hop) => hop.stage), ['seen', 'summary', 'moment', 'held', 'field', 'judge'])
  assert.equal(trail.hops[1]!.body, mirror.text, 'the exact standard-surface mirror is followed')
  assert.equal(trail.hops[1]!.title, 'Published to the summary stream')
  assert.match(trail.hops[1]!.meta!, /no second model call/, 'the mirror is not misreported as another invoke')
  assert.equal(trail.hops[2]!.meta, 'moment.local · extract-3b')
  assert.equal(trail.hops[3]!.guard?.outcome, 'held')

  const wrongSpan = distillate({ ...mirror, id: 'd-wrong', spanId: 'other-screen-pass', text: 'must not join' })
  const exactOnly = buildTrace('ocr-1', records({ ocrResults: [capture()], distillates: [wrongSpan], moments: [], fieldValues: [], guardHolds: [] }))!
  assert.deepEqual(exactOnly.hops.map((hop) => hop.stage), ['seen'], 'when both spans exist, matching source time/chunk cannot override a span mismatch')

  // Real screen-processor repair shape: a pre-#116 OcrResult survives without a span and the repaired
  // missing mirror receives one. Source fallback is allowed only because no exact pair can exist.
  const repairedCapture = capture()
  delete repairedCapture.spanId
  const repairedPair = buildTrace(
    'ocr-1',
    records({ ocrResults: [repairedCapture], distillates: [mirror, otherSessionExact], moments: [], fieldValues: [], guardHolds: [] }),
  )!
  assert.deepEqual(repairedPair.hops.map((hop) => hop.stage), ['seen', 'summary'])
  assert.equal(repairedPair.hops[1]!.body, mirror.text)
})

test('buildTrace: field history keeps original producer value/time and ordered judge revisions', () => {
  const original = fieldValue()
  const producer = { ...original.provenance }
  delete producer.judge
  const provisional = fieldValue({
    state: 'provisional',
    value: 'planning',
    spanId: 'field-pass-old',
    provenance: producer,
    updatedAt: '2026-07-12T12:00:30.000Z',
  })
  const reviewed = fieldValue({ ...original, spanId: 'field-pass-old' })
  const reviewedAgain = fieldValue({
    ...reviewed,
    value: 'Final Q3 launch sequencing',
    provenance: {
      ...reviewed.provenance,
      judge: {
        ...reviewed.provenance.judge!,
        priorValue: reviewed.value,
        note: 'second review tightened the wording',
        judgedAt: '2026-07-12T12:01:30.000Z',
        spanId: 'span-judge-2',
      },
    },
    updatedAt: '2026-07-12T12:01:30.000Z',
  })
  const later = fieldValue({
    state: 'provisional',
    value: 'A later unrelated update',
    spanId: 'field-pass-new',
    provenance: { ...producer, sourceChunks: ['cap-2'] },
    updatedAt: '2026-07-12T12:10:00.000Z',
  })

  const trail = buildTrace(
    'seg-1',
    records({ distillates: [], moments: [], fieldValues: [provisional, reviewed, reviewedAgain, later], guardHolds: [] }),
  )!
  assert.deepEqual(trail.hops.map((hop) => hop.stage), ['field', 'judge', 'judge'])
  assert.equal(trail.hops[0]!.title, 'Field “Topic” updated · provisional')
  assert.equal(trail.hops[0]!.body, 'planning', 'the original fast producer value is not overwritten by correction')
  assert.equal(trail.hops[0]!.at, '2026-07-12T12:00:30.000Z', 'the original producer time is retained')
  assert.match(trail.hops[1]!.body!, /Changed to “Q3 launch sequencing”/)
  assert.match(trail.hops[2]!.body!, /Changed to “Final Q3 launch sequencing”/)
  assert.ok(trail.hops.every((hop) => hop.body !== 'A later unrelated update'), 'the later cap-2 projection did not leak into cap-1 history')
})

test('buildTrace: distinct field passes retain append order when their clocks move backward', () => {
  const producer = { ...fieldValue().provenance }
  delete producer.judge
  const first = fieldValue({
    value: 'first appended pass', state: 'provisional', spanId: 'field-pass-first', provenance: producer,
    updatedAt: '2026-07-12T12:10:00.000Z',
  })
  const second = fieldValue({
    value: 'second appended pass', state: 'provisional', spanId: 'field-pass-second', provenance: producer,
    updatedAt: '2026-07-12T11:00:00.000Z',
  })
  const trail = buildTrace(
    'seg-1',
    records({ distillates: [], moments: [], fieldValues: [first, second], guardHolds: [] }),
  )!
  assert.deepEqual(
    trail.hops.map((hop) => hop.body),
    ['first appended pass', 'second appended pass'],
    'cross-pass updatedAt sorting must not reverse persisted append order',
  )
})

test('renderTrace: every state is TEXT — empty, unknown selection, no steps yet, failed assembly, no data', () => {
  // empty: nothing recorded yet
  const empty = renderTrace(setup({ inputs: [] }))
  assert.match(empty, /Nothing to trace yet/)
  assert.match(empty, /Start a session and speak/)

  // unknown selection: honest not-found, picker still usable
  const r = records()
  const unknown = renderTrace(setup({ inputs: buildTraceInputs(r), selectedId: 'gone' }))
  assert.match(unknown, /That input isn’t in the recorded trail/)
  assert.match(unknown, /Pick an input/)

  // selected but nothing downstream yet: the truth, not a blank
  const rootOnly = renderTrace(setup({ inputs: buildTraceInputs(r), selectedId: 'seg-1', trail: { input: buildTraceInputs(r)[0]!, hops: [] } }))
  assert.match(rootOnly, /No steps recorded from this input yet/)

  // failed assembly: the TRUE reason as visible text
  const failed = renderTrace(setup({ inputs: [], problem: 'SQLITE_CORRUPT: database disk image is malformed' }))
  assert.match(failed, /Trace unavailable/)
  assert.match(failed, /SQLITE_CORRUPT: database disk image is malformed/)

  // the route never assembled data at all (unwired caller): still explains itself
  const unwired = renderTrace(setup(undefined))
  assert.match(unwired, /Trace unavailable/)
})

test('renderTrace: legacy invokes say policy not recorded, while a screen mirror invents no policy row', () => {
  const legacySegment = segment({
    provenance: { slot: 'stt', endpoint: 'legacy-stt', model: 'old-model' },
  })
  const legacySummary = distillate({
    provenance: { slot: 'llm', endpoint: 'legacy-summary' },
  })
  const legacyMoment = moment({
    provenance: { distillateId: legacySummary.id, slot: 'llm', endpoint: 'legacy-moment' },
  })
  const legacyRecords = records({
    sttSegments: [legacySegment], distillates: [legacySummary], moments: [legacyMoment], fieldValues: [], guardHolds: [],
  })
  const legacyHtml = renderTrace(
    setup({ inputs: buildTraceInputs(legacyRecords), selectedId: legacySegment.id, trail: buildTrace(legacySegment.id, legacyRecords)! }),
  )
  assert.match(legacyHtml, /guard not recorded/)
  assert.match(legacyHtml, /destination not recorded/)
  assert.doesNotMatch(legacyHtml, /local[^<]*scope not recorded/, 'Trace never turns absent destination provenance into local')

  const mirror = distillate({
    id: 'd-policy-mirror', sourceChunks: ['frame-1'], spanId: 'span-screen', text: capture().text,
    provenance: capture().provenance,
  })
  const screenRecords = records({ ocrResults: [capture()], distillates: [mirror], moments: [], fieldValues: [], guardHolds: [] })
  const screenHtml = renderTrace(
    setup({ inputs: buildTraceInputs(screenRecords), selectedId: 'ocr-1', trail: buildTrace('ocr-1', screenRecords)! }),
  )
  assert.equal(
    (screenHtml.match(/class="trc-verdicts"/g) ?? []).length,
    1,
    'the OCR seen invoke has one policy row; its durable summary-stream mirror has none',
  )
  assert.match(screenHtml, /no second model call/)
})

test('renderTrace: the full walk renders the chain, verdicts, and the honest pre-#116 disclosure', () => {
  const r = records()
  const html = renderTrace(setup({ inputs: buildTraceInputs(r), selectedId: 'seg-1', trail: buildTrace('seg-1', r)! }))
  assert.match(html, /Heard · Microphone · 118 characters heard/)
  assert.match(html, /transcribed by whisper-box/)
  assert.match(html, /Summarized/)
  assert.match(html, /They agreed to ship Thursday\./)
  assert.match(html, /Noted a commitment/)
  assert.match(html, /Field “Topic” updated · corrected/)
  assert.match(html, /Judge corrected it/)
  assert.match(html, /clean/, 'the guard verdict renders on the hop')
  assert.match(html, /device-local/, 'the egress decision renders on the hop')
  assert.match(html, /Records made before tracing landed/, 'the pre-#116 walkability limit is disclosed')
  // The selected input link is marked, and inputs are real links into this same served page.
  assert.match(html, /href="\/settings\/trace\?input=seg-1"/)
})
