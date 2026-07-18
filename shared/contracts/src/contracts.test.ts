import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Value } from '@sinclair/typebox/value'
import { AllSchemas, Events } from './index.js'

const here = dirname(fileURLToPath(import.meta.url))
const examplesDir = join(here, '..', 'examples')

// filename convention: <schemaLowerCamel>.<label>.json ; flag.examples.json is an array of Flag
const fileSchema: Record<string, keyof typeof AllSchemas> = {
  guardPolicy: 'GuardPolicy', guardHold: 'GuardHold', guardVerdict: 'GuardVerdict',
  register: 'Register', fabric: 'Fabric', mode: 'Mode', surface: 'Surface', workflow: 'WorkflowSpec', bundle: 'Bundle', todo: 'TodoList',
  flag: 'Flag', workspaceHints: 'WorkspaceHints', commitment: 'Commitment', workspace: 'Workspace', moment: 'Moment',
  ocrInvokeParams: 'OcrInvokeParams', vlmInvokeParams: 'VlmInvokeParams',
  captureChunk: 'CaptureChunk', captureReceipt: 'CaptureReceipt', focusSignal: 'FocusSignal', calendarSignal: 'CalendarSignal', ack: 'Ack', transcriptUpdate: 'TranscriptUpdate', health: 'Health', queueStatus: 'QueueStatus', queueFailure: 'QueueFailure',
  distillate: 'Distillate', screenFrameMeta: 'ScreenFrameMeta', ocrResult: 'OcrResult', draft: 'Draft', promptTemplate: 'PromptTemplate', entity: 'Entity', relevantEntity: 'RelevantEntity', fieldValue: 'FieldValue',
  sessionAnnotation: 'SessionAnnotation', sessionTitling: 'SessionTitling', sttSegment: 'SttSegment', contextPacket: 'ContextPacket', summary: 'Summary', claim: 'Claim',
  session: 'Session', startSessionRequest: 'StartSessionRequest', rerouteRequest: 'RerouteRequest', setSessionTitleRequest: 'SetSessionTitleRequest', queryResult: 'QueryResult',
  pin: 'Pin', pinChunk: 'PinChunk', teachSignal: 'TeachSignal', entityCorrection: 'EntityCorrection',
  fabricProfile: 'FabricProfile', secretRef: 'SecretRef', secretValue: 'SecretValue',
  endpointProbe: 'EndpointProbe', generateProbe: 'GenerateProbe',
  probeList: 'ProbeList', capabilityMap: 'CapabilityMap', discoverResult: 'DiscoverResult',
  scanRequest: 'ScanRequest', scanResult: 'ScanResult',
  starterModels: 'StarterModels', starterModel: 'StarterModel',
  localModelStatus: 'LocalModelStatus', localDownloadRequest: 'LocalDownloadRequest',
}

for (const file of readdirSync(examplesDir).filter((f) => f.endsWith('.json'))) {
  const prefix = file.split('.')[0]!
  const schemaName = fileSchema[prefix]
  test(`example ${file} validates against ${String(schemaName)}`, () => {
    assert.ok(schemaName, `no schema mapping for prefix "${prefix}"`)
    const schema = AllSchemas[schemaName]
    const doc: unknown = JSON.parse(readFileSync(join(examplesDir, file), 'utf8'))
    const docs = Array.isArray(doc) ? doc : [doc]
    for (const d of docs) {
      const errors = [...Value.Errors(schema, d)]
      assert.deepEqual(errors.map((e) => `${e.path}: ${e.message}`), [], `${file} failed validation`)
    }
  })
}

test('drift card steps always offer exactly two ways back', () => {
  const mode = JSON.parse(readFileSync(join(examplesDir, 'mode.meeting.json'), 'utf8'))
  const card = mode.drift.chain.find((s: { step: string }) => s.step === 'card')
  assert.equal(card.offer.length, 2)
})

test('ContextPacket is refs-only and rejects copied prose or content fields (#176)', () => {
  const packet = JSON.parse(readFileSync(join(examplesDir, 'contextPacket.window.json'), 'utf8'))
  assert.deepEqual([...Value.Errors(AllSchemas.ContextPacket, packet)], [], 'refs-only packet validates')
  // A packet must never duplicate observation content into a second table: no prose/text/transcript
  // field validates, and a ref cannot smuggle content alongside its id.
  for (const forbidden of ['text', 'prose', 'transcript', 'summary']) {
    const unsafe = { ...packet, [forbidden]: 'copied ambient content' }
    assert.ok([...Value.Errors(AllSchemas.ContextPacket, unsafe)].length > 0, `${forbidden} is rejected`)
  }
  const smuggling = {
    ...packet,
    microphone: [{ record: 'stt-segment', id: 'stt-mic-0001', at: '2026-07-12T13:00:00.000Z', text: 'heard words' }],
  }
  assert.ok([...Value.Errors(AllSchemas.ContextPacket, smuggling)].length > 0, 'a ref carrying content is rejected')
})

test('Summary is refs-only, marks prose as a model proposal, and stays honest when degraded (#177)', () => {
  const summary = JSON.parse(readFileSync(join(examplesDir, 'summary.fiveMinute.json'), 'utf8'))
  assert.deepEqual([...Value.Errors(AllSchemas.Summary, summary)], [], 'a refs-only proposed summary validates')

  // #246: a MODEL summary's prose is a PROPOSAL (`proposal:true`); a SOVEREIGN user correction demotes it to
  // `proposal:false`. `proposal` is a boolean (both are representable) so the correction path is expressible,
  // but the honest source is what distinguishes them — a `source:'user'` correction carries a `correction`
  // stamp + `corrects` link and human prose, and outranks the model proposal at read time (store-resolved).
  const correction = { ...summary, id: 'sum-user-1', text: 'the corrected prose', proposal: false, source: 'user', correction: { at: summary.createdAt }, corrects: summary.id, confidence: 1 }
  assert.deepEqual([...Value.Errors(AllSchemas.Summary, correction)], [], 'a sovereign user correction (proposal:false, source:user) validates')
  assert.ok([...Value.Errors(AllSchemas.Summary, { ...summary, source: 'robot' })].length > 0, 'an invented source is rejected (closed union)')
  // A correction stamp is itself a first-class, closed shape (no smuggled extra fields).
  assert.deepEqual([...Value.Errors(AllSchemas.SummaryCorrection, { at: summary.createdAt, by: 'me' })], [], 'a correction stamp validates')

  // Children are refs only: a child cannot smuggle copied content alongside its id.
  const smuggling = { ...summary, children: [{ record: 'summary', id: 'sum-x', at: summary.windowStart, role: 'child', text: 'copied prose' }] }
  assert.ok([...Value.Errors(AllSchemas.Summary, smuggling)].length > 0, 'a child ref carrying content is rejected')

  // Honest unavailable state: a DEGRADED summary carries NO prose and an explicit machine-visible reason —
  // no fabricated text, and the deterministic children/derivation path is still intact.
  const { text: _text, ...withoutText } = summary
  const degraded = {
    ...withoutText,
    degraded: { reason: 'no summarizer endpoint configured (fabric llm slot is empty)' },
    provenance: { builder: 'bounded-hierarchical-summary', windowMs: 300000, childLevel: 'rolling', templateId: 'tpl-summary-five-minute' },
  }
  assert.deepEqual([...Value.Errors(AllSchemas.Summary, degraded)], [], 'a degraded (prose-less) summary validates honestly')

  // The level enum is COMPLETE now (all five levels typed) even though slice 1 produces only some.
  for (const level of ['rolling', 'episode', 'five-minute', 'session', 'project']) {
    assert.deepEqual([...Value.Errors(AllSchemas.SummaryLevel, level)], [], `${level} is a typed level`)
  }
  assert.ok([...Value.Errors(AllSchemas.SummaryLevel, 'decade')].length > 0, 'an invented level is rejected')
})

test('Claim is refs-only, evidence is mandatory, and the relation union stays closed (#178)', () => {
  const claim = JSON.parse(readFileSync(join(examplesDir, 'claim.coOccurrence.json'), 'utf8'))
  assert.deepEqual([...Value.Errors(AllSchemas.Claim, claim)], [], 'a refs-only derived claim validates')

  // EVIDENCE IS MANDATORY: a claim with no evidence refs is UNREPRESENTABLE (minItems:1) — the #178
  // "every claim must be traceable to source observations" invariant, enforced by the schema itself.
  assert.ok([...Value.Errors(AllSchemas.Claim, { ...claim, evidence: [] })].length > 0, 'a claim with no evidence is rejected')

  // Refs-only: an evidence ref cannot smuggle copied observation content alongside its id.
  const smuggling = { ...claim, evidence: [{ record: 'context-packet', id: 'cp-x', at: claim.firstObserved, text: 'copied content' }] }
  assert.ok([...Value.Errors(AllSchemas.Claim, smuggling)].length > 0, 'an evidence ref carrying content is rejected')

  // The relation union is CLOSED — all six kinds are typed even though slice 1 produces only co-occurs-with.
  for (const relation of ['co-occurs-with', 'works-on', 'belongs-to', 'authored', 'member-of', 'relates-to']) {
    assert.deepEqual([...Value.Errors(AllSchemas.ClaimRelation, relation)], [], `${relation} is a typed relation`)
  }
  assert.ok([...Value.Errors(AllSchemas.ClaimRelation, 'is-friends-with')].length > 0, 'an invented relation is rejected')

  // The evidence-source set is closed: a distillate/moment/context-packet is allowed, an entity is not
  // (a claim rests on converged evidence, never directly on another derived aggregate).
  assert.ok([...Value.Errors(AllSchemas.ClaimEvidenceRef, { record: 'entity', id: 'ent-x', at: claim.firstObserved })].length > 0, 'entity is not an evidence source')

  // A SOVEREIGN user correction validates: source 'user' + a correction stamp + the target link, no builder.
  const correction = JSON.parse(readFileSync(join(examplesDir, 'claim.userConfirm.json'), 'utf8'))
  assert.deepEqual([...Value.Errors(AllSchemas.Claim, correction)], [], 'a user correction validates')
})

test('CaptureReceipt is metadata-only and rejects raw or derived content fields', () => {
  const receipt = {
    id: 'scr-sess-1-000001', sessionId: 'sess-1', workspaceId: 'default', source: 'screen',
    sequence: 1, capturedAt: '2026-07-12T12:00:00.000Z', contentType: 'image/jpeg',
    encoding: 'base64', payloadBytes: 75000,
  }
  assert.deepEqual([...Value.Errors(AllSchemas.CaptureReceipt, receipt)], [], 'metadata-only receipt validates')
  for (const forbidden of ['data', 'preview', 'hash']) {
    const unsafe = { ...receipt, [forbidden]: 'secret-derived-value' }
    assert.ok([...Value.Errors(AllSchemas.CaptureReceipt, unsafe)].length > 0, `${forbidden} is rejected`)
  }
})

const senseLane = (source: 'mic' | 'system-audio' | 'screen') => ({
  workspaceId: 'default', sessionId: 'session-live', source,
  disposition: 'processed', health: 'healthy', reason: 'processed',
  updatedAt: '2026-07-13T12:00:02.000Z',
  latestCapture: { id: `${source}-capture`, capturedAt: '2026-07-13T12:00:00.000Z' },
  latestProcessing: {
    captureId: `${source}-capture`, capturedAt: '2026-07-13T12:00:00.000Z',
    completedAt: '2026-07-13T12:00:01.250Z', outcome: 'processed', lagMs: 1250,
    basis: 'capture-to-processing-completion',
  },
})

test('sense-lanes is a closed surface block over the live-senses query source', () => {
  const query = { source: 'live-senses', params: { workspace: 'default', session: 'session-live' } }
  const block = { block: 'sense-lanes', show: 'always', query }
  const surface = {
    id: 'surf-live-senses', name: 'Live senses', context: 'any', version: 1,
    stack: [block],
  }
  const rows = [senseLane('mic'), senseLane('system-audio'), senseLane('screen')]
  const result = { source: 'live-senses', items: rows, truncated: false }

  assert.deepEqual([...Value.Errors(AllSchemas.BlockTypeName, 'sense-lanes')], [], 'block kind is registered')
  assert.deepEqual([...Value.Errors(AllSchemas.BlockQuery, query)], [], 'query source is registered')
  assert.deepEqual([...Value.Errors(AllSchemas.Block, block)], [], 'block composes the registered query')
  assert.deepEqual([...Value.Errors(AllSchemas.Surface, surface)], [], 'surface embeds the new block')
  assert.deepEqual([...Value.Errors(AllSchemas.QueryResult, result)], [], 'query result accepts existing lane rows')
  for (const row of rows) {
    assert.deepEqual(
      [...Value.Errors(AllSchemas.SenseLaneSnapshot, row)],
      [],
      'live-senses reuses the canonical SenseLaneSnapshot row',
    )
  }

  assert.ok([...Value.Errors(AllSchemas.BlockTypeName, 'sense-lane')].length > 0, 'invented block kind is rejected')
  assert.ok(
    [...Value.Errors(AllSchemas.BlockQuery, { ...query, source: 'ambient-senses' })].length > 0,
    'invented query source is rejected',
  )
  assert.ok(
    [...Value.Errors(AllSchemas.QueryResult, { ...result, source: 'ambient-senses' })].length > 0,
    'invented result source is rejected',
  )
  assert.ok(
    [...Value.Errors(AllSchemas.BlockQuery, { ...query, rawFrames: true })].length > 0,
    'query contract remains closed',
  )
})

test('QueryResult carries the additive no-current-session scope disclosure (#215), present only when true', () => {
  // The honest empty-scope flag rides the QueryResult so a session-scoped block distinguishes "no session
  // running" from "live but nothing captured yet". Additive/optional: a result WITHOUT it is still valid
  // (existing consumers unaffected), a result WITH it true validates, and it is boolean-typed (no enum leak).
  const base = { source: 'moments', items: [], truncated: false }
  assert.deepEqual([...Value.Errors(AllSchemas.QueryResult, base)], [], 'disclosure is optional — absent is valid')
  assert.deepEqual(
    [...Value.Errors(AllSchemas.QueryResult, { ...base, noCurrentSession: true })],
    [],
    'disclosure validates when present and true',
  )
  assert.ok(
    [...Value.Errors(AllSchemas.QueryResult, { ...base, noCurrentSession: 'yes' })].length > 0,
    'disclosure is boolean-typed — a string is rejected (contract stays closed)',
  )
})

test('SenseLaneSnapshot/Set are atomic, metadata-only, and pin the canonical three-lane tuple', () => {
  const mic = senseLane('mic')
  const valid = {
    workspaceId: 'default', sessionId: 'session-live',
    lanes: [mic, senseLane('system-audio'), senseLane('screen')],
  }
  assert.deepEqual([...Value.Errors(AllSchemas.SenseLaneSnapshot, mic)], [], 'one complete metadata row validates')
  assert.deepEqual([...Value.Errors(AllSchemas.SenseLaneSnapshotSet, valid)], [], 'canonical tuple validates')

  const duplicate = { ...valid, lanes: [mic, senseLane('mic'), senseLane('screen')] }
  assert.ok([...Value.Errors(AllSchemas.SenseLaneSnapshotSet, duplicate)].length > 0, 'duplicate lane is rejected')
  const wrongOrder = { ...valid, lanes: [senseLane('system-audio'), mic, senseLane('screen')] }
  assert.ok([...Value.Errors(AllSchemas.SenseLaneSnapshotSet, wrongOrder)].length > 0, 'wrong tuple position is rejected')

  const { basis: _basis, ...partialProcessing } = mic.latestProcessing
  assert.ok([
    ...Value.Errors(AllSchemas.SenseLaneSnapshot, { ...mic, latestProcessing: partialProcessing }),
  ].length > 0, 'processing evidence is all-or-none')
  const { outcome: _outcome, ...outcomelessProcessing } = mic.latestProcessing
  assert.ok([
    ...Value.Errors(AllSchemas.SenseLaneSnapshot, { ...mic, latestProcessing: outcomelessProcessing }),
  ].length > 0, 'processing evidence always names its terminal outcome')
  const { capturedAt: _capturedAt, ...partialCapture } = mic.latestCapture
  assert.ok([
    ...Value.Errors(AllSchemas.SenseLaneSnapshot, { ...mic, latestCapture: partialCapture }),
  ].length > 0, 'capture evidence is all-or-none')

  for (const forbidden of ['data', 'text', 'preview', 'hash', 'error']) {
    assert.ok(
      [...Value.Errors(AllSchemas.SenseLaneSnapshot, { ...mic, [forbidden]: 'captured-or-unsanitized-content' })].length > 0,
      `${forbidden} is rejected`,
    )
  }
  assert.equal(Events['sense.lane.updated'], 'SenseLaneSnapshot')
})

test('ScreenCaptureObservation is a closed, metadata-only discriminated union', () => {
  const common = { workspaceId: 'default', sessionId: 'session-live' }
  const queued = {
    ...common,
    outcome: 'queued',
    capture: { id: 'screen-1', capturedAt: '2026-07-13T12:00:00.000Z' },
  }
  const skipped = {
    ...common,
    outcome: 'delta-skipped',
    observationId: 'screen-attempt-2',
    occurredAt: '2026-07-13T12:00:01.000Z',
  }
  const failed = {
    ...common,
    outcome: 'grab-failed',
    observationId: 'screen-attempt-3',
    occurredAt: '2026-07-13T12:00:02.000Z',
  }
  for (const value of [queued, skipped, failed]) {
    assert.deepEqual([...Value.Errors(AllSchemas.ScreenCaptureObservation, value)], [], `${value.outcome} validates`)
  }

  assert.ok([...Value.Errors(AllSchemas.ScreenCaptureObservation, { ...queued, observationId: 'not-allowed' })].length > 0)
  assert.ok([...Value.Errors(AllSchemas.ScreenCaptureObservation, { ...skipped, capture: queued.capture })].length > 0)
  assert.ok([...Value.Errors(AllSchemas.ScreenCaptureObservation, { ...failed, outcome: 'made-up' })].length > 0)
  for (const forbidden of ['data', 'text', 'preview', 'hash', 'display', 'deltaScore', 'error']) {
    assert.ok(
      [...Value.Errors(AllSchemas.ScreenCaptureObservation, { ...skipped, [forbidden]: 'private-or-derived' })].length > 0,
      `${forbidden} is rejected`,
    )
  }

  const processing = {
    ...common,
    outcome: 'blank',
    capture: queued.capture,
    completedAt: '2026-07-13T12:00:03.000Z',
  }
  assert.deepEqual([...Value.Errors(AllSchemas.ScreenProcessingOutcome, processing)], [])
  assert.ok([...Value.Errors(AllSchemas.ScreenProcessingOutcome, { ...processing, error: 'private' })].length > 0)
})

test('ScreenLaneObservation gives attempt provenance only to the screen lane', () => {
  const latestObservation = {
    id: 'screen-attempt-4',
    occurredAt: '2026-07-13T12:00:04.000Z',
    outcome: 'delta-skipped',
  }
  const screen = { ...senseLane('screen'), disposition: 'delta-skipped', reason: 'delta-skipped', latestObservation }
  assert.deepEqual([...Value.Errors(AllSchemas.ScreenLaneObservation, latestObservation)], [])
  assert.deepEqual([...Value.Errors(AllSchemas.SenseLaneSnapshot, screen)], [], 'screen row retains exact attempt derivation')
  assert.ok(
    [...Value.Errors(AllSchemas.SenseLaneSnapshot, { ...senseLane('mic'), latestObservation })].length > 0,
    'microphone row cannot claim screen-attempt provenance',
  )
  assert.ok(
    [...Value.Errors(AllSchemas.SenseLaneSnapshot, { ...senseLane('system-audio'), latestObservation })].length > 0,
    'system-audio row cannot claim screen-attempt provenance',
  )
  const { occurredAt: _occurredAt, ...partial } = latestObservation
  assert.ok([...Value.Errors(AllSchemas.ScreenLaneObservation, partial)].length > 0, 'observation evidence is atomic')
  assert.ok([
    ...Value.Errors(AllSchemas.ScreenLaneObservation, { ...latestObservation, outcome: 'queued' }),
  ].length > 0, 'queued provenance belongs to latestCapture, not latestObservation')
  for (const forbidden of ['data', 'text', 'preview', 'hash', 'display', 'deltaScore', 'error']) {
    assert.ok(
      [...Value.Errors(AllSchemas.ScreenLaneObservation, { ...latestObservation, [forbidden]: 'private-or-derived' })].length > 0,
      `${forbidden} is rejected from retained attempt provenance`,
    )
  }
})

test('TranscriptUpdate requires true capture provenance and processing time', () => {
  const update = {
    sessionId: 'ses-1', source: 'mic', text: 'same words',
    sourceChunkIds: ['mic-ses-1-000001'],
    sourceSequenceRange: { start: 1, end: 1 },
    capturedAtRange: { start: '2026-07-12T12:00:00.000Z', end: '2026-07-12T12:00:01.000Z' },
    processedAt: '2026-07-12T12:00:01.250Z',
  }
  assert.deepEqual([...Value.Errors(AllSchemas.TranscriptUpdate, update)], [], 'source-provenanced update validates')
  assert.ok([...Value.Errors(AllSchemas.TranscriptUpdate, { ...update, sourceChunkIds: [] })].length > 0, 'an update cannot lose all source ids')
  const { sourceSequenceRange: _sourceSequenceRange, ...withoutSequence } = update
  assert.ok([...Value.Errors(AllSchemas.TranscriptUpdate, withoutSequence)].length > 0, 'source-local sequence evidence is required')
  const { processedAt: _processedAt, ...withoutProcessedAt } = update
  assert.ok([...Value.Errors(AllSchemas.TranscriptUpdate, withoutProcessedAt)].length > 0, 'processing time is required')
})

test('every public event names a registered payload schema', () => {
  for (const [event, schema] of Object.entries(Events)) {
    assert.ok(schema in AllSchemas, `${event} references missing schema ${schema}`)
  }
  assert.equal(Events['capture.received'], 'CaptureReceipt')
})

// #102 keep-time: OcrResult.capturedAt is append-only/optional — a record WITHOUT it must still validate
// (pre-existing records predate the field), and one WITH it validates.
test('OcrResult validates with and without capturedAt (append-only)', () => {
  const base = {
    id: 'ocr-1', sessionId: 's-1', workspaceId: 'default', sourceChunks: ['c-1'],
    text: 'hello screen', provenance: { slot: 'ocr', endpoint: 'paddle' },
    schemaVersion: 1, createdAt: '2026-07-10T14:00:00Z',
  }
  assert.deepEqual([...Value.Errors(AllSchemas.OcrResult, base)], [], 'old record (no capturedAt) still validates')
  const withCapturedAt = { ...base, capturedAt: '2026-07-10T13:59:30Z' }
  assert.deepEqual([...Value.Errors(AllSchemas.OcrResult, withCapturedAt)], [], 'record with capturedAt validates')
})

test('#196 EgressDecision destination detail is additive, closed, and payload-free', () => {
  const legacy = {
    reach: 'local',
    allowed: false,
    decidedBy: 'content-class',
    reason: 'legacy local decision',
  }
  assert.deepEqual([...Value.Errors(AllSchemas.EgressDecision, legacy)], [], 'pre-#196 decision still validates')

  const trustedLan = {
    ...legacy,
    reason: 'raw screen bytes crossed the device boundary to an explicitly trusted LAN destination',
    destination: 'lan-local',
    rawFrameTrust: 'explicit',
  }
  assert.deepEqual([...Value.Errors(AllSchemas.EgressDecision, trustedLan)], [], 'additive trusted-LAN detail validates')
  assert.ok(
    [...Value.Errors(AllSchemas.EgressDecision, { ...trustedLan, destination: 'private-url' })].length > 0,
    'destination is a closed safe enum',
  )
  assert.ok(
    [...Value.Errors(AllSchemas.EgressDecision, { ...trustedLan, rawFrameTrust: true })].length > 0,
    'raw-frame trust is the explicit literal, not a generic boolean',
  )
  assert.ok(
    [...Value.Errors(AllSchemas.EgressDecision, { ...trustedLan, url: 'http://private-host' })].length > 0,
    'URLs cannot enter provenance',
  )
})

// #102 keep-time: QueueStatus.lag is additive/optional; BacklogLag is honest about basis + non-negative.
test('QueueStatus.lag (BacklogLag) is additive and honest', () => {
  const base = { pendingFiles: 0, pendingBytes: 0, drainedFiles: 0, updatedAt: '2026-07-10T14:00:00Z' }
  assert.deepEqual([...Value.Errors(AllSchemas.QueueStatus, base)], [], 'status without lag validates (caught up)')
  const lagging = { ...base, lag: { behindMs: 42000, oldestPendingCapturedAt: '2026-07-10T13:59:18Z', basis: 'capture-time' } }
  assert.deepEqual([...Value.Errors(AllSchemas.QueueStatus, lagging)], [], 'status with a capture-time lag validates')
  const unknown = { ...base, lag: { behindMs: 0, basis: 'unknown' } }
  assert.deepEqual([...Value.Errors(AllSchemas.QueueStatus, unknown)], [], 'status with an unknown-basis lag validates')
  assert.ok([...Value.Errors(AllSchemas.BacklogLag, { behindMs: -1, basis: 'capture-time' })].length > 0, 'negative behindMs is rejected')
  assert.ok([...Value.Errors(AllSchemas.BacklogLag, { behindMs: 0, basis: 'made-up' })].length > 0, 'an invented basis is rejected')
})

// #131 orientation: FastFieldBinding.produces is additive/optional — a #62 judge doc WITHOUT it still
// validates (defaults to a verdict judge), and a doc WITH produces:'orientation' validates. An invented
// output shape is rejected (closed union).
test('#131 FastFieldBinding.produces is additive/optional and closed', () => {
  const verdict = { fieldId: 'judge-default', tier: 'judge', trigger: { kind: 'transcript' }, scope: 'session' }
  assert.deepEqual([...Value.Errors(AllSchemas.FastFieldBinding, verdict)], [], 'a #62 judge binding (no produces) still validates')
  const orientation = { ...verdict, fieldId: 'judge-orientation', produces: 'orientation' }
  assert.deepEqual([...Value.Errors(AllSchemas.FastFieldBinding, orientation)], [], "produces:'orientation' validates")
  assert.ok([...Value.Errors(AllSchemas.FastFieldBinding, { ...verdict, produces: 'made-up' })].length > 0, 'an invented produces is rejected')
})

// #131 orientation: SessionAnnotation is the engine-stamped session-nature reading — an "unclear" reading
// (thin source, empty topics) validates as honestly as a rich one; the model never controls ids/provenance.
// bundle-as-runtime-object: a Bundle is additive — a MINIMAL bundle (faces only) validates, so do the
// optional workflow/template/flags/chat organs; the face-kind and chat-source unions are CLOSED, so an
// unrunnable face role or an ungatherable chat source is rejected at write time (the Tier-A gate).
test('Bundle: a minimal faces-only bundle validates; organs are optional', () => {
  const minimal = { id: 'b-min', name: 'Min', version: 1, faces: [{ kind: 'hud', surfaceRef: 'surf-openinfo-hud' }] }
  assert.deepEqual([...Value.Errors(AllSchemas.Bundle, minimal)], [], 'a faces-only bundle validates (organs optional)')
  const full = {
    ...minimal,
    workflowRef: 'workflow-default',
    templateRefs: ['tpl-distill-default'],
    flags: { 'distill.enabled': true },
    chat: { sources: [{ kind: 'recent-turns', limit: 8 }, { kind: 'bundle-prompt' }] },
  }
  assert.deepEqual([...Value.Errors(AllSchemas.Bundle, full)], [], 'a fully-populated bundle validates')
})

test('Bundle: face-kind and chat-source unions are closed', () => {
  const badFace = { id: 'b-1', name: 'B', version: 1, faces: [{ kind: 'sidebar', surfaceRef: 's' }] }
  assert.ok([...Value.Errors(AllSchemas.Bundle, badFace)].length > 0, 'an unknown face kind is rejected')
  const noFaces = { id: 'b-1', name: 'B', version: 1, faces: [] }
  assert.ok([...Value.Errors(AllSchemas.Bundle, noFaces)].length > 0, 'a bundle with no faces is rejected (minItems 1)')
  const badSource = { id: 'b-1', name: 'B', version: 1, faces: [{ kind: 'hud', surfaceRef: 's' }], chat: { sources: [{ kind: 'weather' }] } }
  assert.ok([...Value.Errors(AllSchemas.Bundle, badSource)].length > 0, 'an unknown chat source kind is rejected')
})

test('#131 SessionAnnotation validates rich and unclear readings', () => {
  const base = {
    id: 'oa:default:sess-1', workspaceId: 'default', sessionId: 'sess-1',
    provenance: { templateId: 'tpl-judge-orientation', endpoint: 'llm.judge', classifiedAt: '2026-07-10T12:00:00.000Z' },
    updatedAt: '2026-07-10T12:00:00.000Z', schemaVersion: 1,
  }
  const rich = { ...base, nature: 'meeting', direction: 'learn', topics: ['Q3 planning'] }
  assert.deepEqual([...Value.Errors(AllSchemas.SessionAnnotation, rich)], [], 'a rich orientation reading validates')
  const unclear = { ...base, nature: 'unclear', direction: 'unclear', topics: [] }
  assert.deepEqual([...Value.Errors(AllSchemas.SessionAnnotation, unclear)], [], 'an unclear reading (empty topics) validates')
})
