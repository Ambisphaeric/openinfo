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
  sessionAnnotation: 'SessionAnnotation',
  session: 'Session', startSessionRequest: 'StartSessionRequest', rerouteRequest: 'RerouteRequest', queryResult: 'QueryResult',
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
