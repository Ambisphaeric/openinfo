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
