import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Value } from '@sinclair/typebox/value'
import { AllSchemas } from './index.js'

const here = dirname(fileURLToPath(import.meta.url))
const examplesDir = join(here, '..', 'examples')

// filename convention: <schemaLowerCamel>.<label>.json ; flag.examples.json is an array of Flag
const fileSchema: Record<string, keyof typeof AllSchemas> = {
  guardPolicy: 'GuardPolicy', guardHold: 'GuardHold', guardVerdict: 'GuardVerdict',
  register: 'Register', fabric: 'Fabric', mode: 'Mode', surface: 'Surface', workflow: 'WorkflowSpec', todo: 'TodoList',
  flag: 'Flag', workspaceHints: 'WorkspaceHints', commitment: 'Commitment', workspace: 'Workspace', moment: 'Moment',
  ocrInvokeParams: 'OcrInvokeParams', vlmInvokeParams: 'VlmInvokeParams',
  captureChunk: 'CaptureChunk', focusSignal: 'FocusSignal', calendarSignal: 'CalendarSignal', ack: 'Ack', transcriptUpdate: 'TranscriptUpdate', health: 'Health', queueStatus: 'QueueStatus', queueFailure: 'QueueFailure',
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
