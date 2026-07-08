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
  register: 'Register', fabric: 'Fabric', mode: 'Mode', surface: 'Surface', workflow: 'WorkflowSpec',
  flag: 'Flag', workspaceHints: 'WorkspaceHints', commitment: 'Commitment', workspace: 'Workspace', moment: 'Moment',
  captureChunk: 'CaptureChunk', focusSignal: 'FocusSignal', ack: 'Ack', health: 'Health', queueStatus: 'QueueStatus', queueFailure: 'QueueFailure',
  distillate: 'Distillate', screenFrameMeta: 'ScreenFrameMeta', draft: 'Draft', promptTemplate: 'PromptTemplate', entity: 'Entity', relevantEntity: 'RelevantEntity',
  session: 'Session', startSessionRequest: 'StartSessionRequest', rerouteRequest: 'RerouteRequest', queryResult: 'QueryResult',
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
