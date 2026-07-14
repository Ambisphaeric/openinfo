import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Endpoint, Fabric, Flag, QueueFailure, WorkflowSpec, WorkflowStep } from '@openinfo/contracts'
import type { EndpointHealth } from '../../fabric/health.js'
import { evaluateSenseGates, requiredScreenSenseSlots, type CaptureSense, type SenseGateChain, type SenseGateInput } from './sense-gates.js'

const emptyFabric = (): Fabric => ({ slots: { stt: [], tts: [], llm: [], vlm: [], ocr: [], embed: [] } })

const sttEndpoint = (name = 'whisper'): Endpoint => ({ kind: 'http', name, url: 'http://127.0.0.1:9001', api: 'openai-compat', model: 'whisper-1' })
const ocrEndpoint = (name = 'paddle'): Endpoint => ({ kind: 'http', name, url: 'http://127.0.0.1:9002', api: 'paddle-serving' })
const vlmEndpoint = (name = 'gemma-vision'): Endpoint => ({ kind: 'http', name, url: 'http://127.0.0.1:9003', api: 'openai-compat', model: 'gemma-3-12b' })

const flag = (key: string, on: boolean): Flag => ({ key, default: on, scope: 'engine', description: key })

/** All-off flags (the engine default — every flag default:false). */
const baseFlags = ['distill.enabled', 'distill.transcribe', 'screen.ocr', 'workflow.enabled']
const allOff: Flag[] = baseFlags.map((k) => flag(k, false))
const withFlags = (on: string[]): Flag[] => [...new Set([...baseFlags, ...on])].map((k) => flag(k, on.includes(k)))

const workflow = (steps: WorkflowStep[]): WorkflowSpec => ({
  id: 'workflow-default',
  name: 'test workflow',
  version: 1,
  steps,
})
const screenStep = (kind: 'ocr' | 'vlm', over: Partial<WorkflowStep> = {}): WorkflowStep => ({
  id: `screen-${kind}`,
  kind,
  slot: kind,
  trigger: 'drain',
  when: { flag: `screen.${kind}` },
  params: {},
  ...over,
})

const run = (over: Partial<SenseGateInput> = {}): SenseGateChain[] =>
  evaluateSenseGates({ flags: allOff, fabric: emptyFabric(), ...over })
const bySense = (chains: SenseGateChain[], sense: CaptureSense): SenseGateChain => chains.find((c) => c.sense === sense)!

test('covers the three senses in display order', () => {
  assert.deepEqual(
    run().map((c) => c.sense),
    ['mic', 'sys-audio', 'screen'],
  )
})

test('audio precedence: distill.enabled is the first blocker when everything is off', () => {
  for (const sense of ['mic', 'sys-audio'] as const) {
    const chain = bySense(run(), sense)
    assert.equal(chain.blocking?.id, 'distill.enabled')
    assert.match(chain.blocking!.fix!, /Features/)
  }
})

test('audio precedence: distill on but transcribe off ⇒ blocked at distill.transcribe', () => {
  const chain = bySense(run({ flags: withFlags(['distill.enabled']) }), 'mic')
  assert.equal(chain.blocking?.id, 'distill.transcribe')
})

test('audio precedence: flags on, empty stt slot ⇒ blocked at stt (add an endpoint)', () => {
  const chain = bySense(run({ flags: withFlags(['distill.enabled', 'distill.transcribe']) }), 'mic')
  assert.equal(chain.blocking?.id, 'stt')
  assert.match(chain.blocking!.fix!, /Add an stt endpoint/)
})

test('audio: flags on + stt configured + no failure ⇒ clear (no blocker)', () => {
  const fabric = emptyFabric()
  fabric.slots.stt = [sttEndpoint()]
  const chain = bySense(run({ flags: withFlags(['distill.enabled', 'distill.transcribe']), fabric }), 'mic')
  assert.equal(chain.blocking, undefined)
})

test('audio: a queue lastFailure on the stt endpoint closes the health gate, reusing its hint', () => {
  const fabric = emptyFabric()
  fabric.slots.stt = [sttEndpoint('whisper')]
  const lastFailure: QueueFailure = { class: 'unreachable', endpoint: 'whisper', hint: 'Start the stt server on :9001', at: new Date().toISOString() }
  const chain = bySense(run({ flags: withFlags(['distill.enabled', 'distill.transcribe']), fabric, lastFailure }), 'mic')
  assert.equal(chain.blocking?.id, 'stt-health')
  assert.equal(chain.blocking?.fix, 'Start the stt server on :9001') // the classified failure's own hint, reused
})

test('audio: a lastFailure on a DIFFERENT (non-stt) endpoint does not close the stt health gate', () => {
  const fabric = emptyFabric()
  fabric.slots.stt = [sttEndpoint('whisper')]
  const lastFailure: QueueFailure = { class: 'auth', endpoint: 'some-llm', hint: 'fix the llm key', at: new Date().toISOString() }
  const chain = bySense(run({ flags: withFlags(['distill.enabled', 'distill.transcribe']), fabric, lastFailure }), 'mic')
  assert.equal(chain.blocking, undefined)
})

test('audio: a live EndpointHealth failure closes the health gate even without a queue failure', () => {
  const fabric = emptyFabric()
  fabric.slots.stt = [sttEndpoint('whisper')]
  const health: Record<string, EndpointHealth> = { whisper: { name: 'whisper', ok: false, checkedAt: new Date().toISOString(), error: 'HTTP 503' } }
  const chain = bySense(run({ flags: withFlags(['distill.enabled', 'distill.transcribe']), fabric, health }), 'mic')
  assert.equal(chain.blocking?.id, 'stt-health')
  assert.match(chain.blocking!.fix!, /503/)
})

test('screen is independent of distill: it gates on screen.ocr, then the ocr slot', () => {
  // distill flags on but screen.ocr off ⇒ screen is still blocked at screen.ocr (not distill)
  const chain = bySense(run({ flags: withFlags(['distill.enabled', 'distill.transcribe']) }), 'screen')
  assert.equal(chain.blocking?.id, 'screen.ocr')

  // screen.ocr on, empty ocr slot ⇒ blocked at ocr
  const noOcr = bySense(run({ flags: withFlags(['screen.ocr']) }), 'screen')
  assert.equal(noOcr.blocking?.id, 'ocr')
  assert.match(noOcr.blocking!.fix!, /Add an ocr endpoint/)
})

test('screen: screen.ocr on + ocr configured + healthy ⇒ clear', () => {
  const fabric = emptyFabric()
  fabric.slots.ocr = [ocrEndpoint()]
  const chain = bySense(run({ flags: withFlags(['screen.ocr']), fabric }), 'screen')
  assert.equal(chain.blocking, undefined)
})

test('screen OCR fallback: one explicit live success keeps the slot healthy; all failed probes close it', () => {
  const fabric = emptyFabric()
  fabric.slots.ocr = [ocrEndpoint('ocr-down'), ocrEndpoint('ocr-ready')]
  const flags = withFlags(['screen.ocr'])
  const checkedAt = new Date().toISOString()
  const oneReady: Record<string, EndpointHealth> = {
    'ocr-down': { name: 'ocr-down', ok: false, checkedAt, error: 'HTTP 503' },
    'ocr-ready': { name: 'ocr-ready', ok: true, checkedAt, latencyMs: 8 },
  }
  assert.equal(bySense(run({ flags, fabric, health: oneReady }), 'screen').blocking, undefined)

  const allDown: Record<string, EndpointHealth> = {
    ...oneReady,
    'ocr-ready': { name: 'ocr-ready', ok: false, checkedAt, error: 'connection refused' },
  }
  const blocked = bySense(run({ flags, fabric, health: allDown }), 'screen')
  assert.equal(blocked.blocking?.id, 'ocr-health')
  assert.match(blocked.blocking?.fix ?? '', /503|connection refused/)
})

test('screen ownership: workflow OFF preserves the legacy screen.ocr → ocr chain even with a VLM workflow document', () => {
  const activeWorkflow = workflow([screenStep('vlm')])
  const chain = bySense(run({ flags: withFlags(['screen.ocr']), activeWorkflow }), 'screen')
  assert.deepEqual(chain.gates.map((g) => g.id), ['screen.ocr', 'ocr', 'ocr-health'])
  assert.equal(chain.blocking?.id, 'ocr')
  assert.deepEqual(requiredScreenSenseSlots({ flags: withFlags(['screen.ocr']), activeWorkflow }), ['ocr'])
})

test('screen ownership: workflow ON derives an enabled VLM-only drain step and ignores the empty OCR slot', () => {
  const activeWorkflow = workflow([screenStep('vlm')])
  const fabric = emptyFabric()
  fabric.slots.vlm = [vlmEndpoint()]
  const flags = withFlags(['workflow.enabled', 'screen.vlm'])
  const chain = bySense(run({ flags, fabric, activeWorkflow }), 'screen')

  assert.deepEqual(chain.gates.map((g) => g.id), ['screen.vlm', 'vlm', 'vlm-health'])
  assert.equal(chain.blocking, undefined)
  assert.deepEqual(requiredScreenSenseSlots({ flags, activeWorkflow }), ['vlm'])
})

test('screen VLM fallback: a later explicitly healthy endpoint clears an earlier failed probe', () => {
  const activeWorkflow = workflow([screenStep('vlm')])
  const fabric = emptyFabric()
  fabric.slots.vlm = [vlmEndpoint('vision-down'), vlmEndpoint('vision-ready')]
  const flags = withFlags(['workflow.enabled', 'screen.vlm'])
  const checkedAt = new Date().toISOString()
  const health: Record<string, EndpointHealth> = {
    'vision-down': { name: 'vision-down', ok: false, checkedAt, error: 'HTTP 503' },
    'vision-ready': { name: 'vision-ready', ok: true, checkedAt, latencyMs: 12 },
  }
  assert.equal(bySense(run({ flags, fabric, activeWorkflow, health }), 'screen').blocking, undefined)
})

test('screen ownership: enabled OCR + VLM workflow steps require both distinct slots and surface VLM health', () => {
  const activeWorkflow = workflow([screenStep('ocr'), screenStep('vlm')])
  const fabric = emptyFabric()
  fabric.slots.ocr = [ocrEndpoint()]
  fabric.slots.vlm = [vlmEndpoint('vision-down')]
  const flags = withFlags(['workflow.enabled', 'screen.ocr', 'screen.vlm'])
  const health: Record<string, EndpointHealth> = {
    'vision-down': { name: 'vision-down', ok: false, checkedAt: new Date().toISOString(), error: 'HTTP 503' },
  }
  const chain = bySense(run({ flags, fabric, activeWorkflow, health }), 'screen')

  assert.deepEqual(chain.gates.map((g) => g.id), ['screen.ocr', 'screen.vlm', 'ocr', 'ocr-health', 'vlm', 'vlm-health'])
  assert.equal(chain.blocking?.id, 'vlm-health')
  assert.match(chain.blocking!.fix!, /503/)
  assert.deepEqual(requiredScreenSenseSlots({ flags, activeWorkflow }), ['ocr', 'vlm'])
})

test('screen ownership: workflow ON names a disabled step flag or a missing drain step instead of guessing OCR', () => {
  const disabledWorkflow = workflow([screenStep('vlm')])
  const flags = withFlags(['workflow.enabled'])
  const disabled = bySense(run({ flags, activeWorkflow: disabledWorkflow }), 'screen')
  assert.equal(disabled.blocking?.id, 'screen.vlm')
  assert.match(disabled.blocking!.detail!, /Every screen-recognition step/)
  assert.deepEqual(requiredScreenSenseSlots({ flags, activeWorkflow: disabledWorkflow }), [])

  const noScreenWorkflow = workflow([{ id: 'distill', kind: 'distill', slot: 'llm', trigger: 'drain', params: {} }])
  const missing = bySense(run({ flags, activeWorkflow: noScreenWorkflow }), 'screen')
  assert.equal(missing.blocking?.id, 'workflow.screen')
  assert.match(missing.blocking!.fix!, /Add an ocr or vlm drain step/)
})

test('every chain exposes its ordered gates so the readout can show the whole pipeline', () => {
  const mic = bySense(run(), 'mic')
  assert.deepEqual(mic.gates.map((g) => g.id), ['distill.enabled', 'distill.transcribe', 'stt', 'stt-health'])
  const screen = bySense(run(), 'screen')
  assert.deepEqual(screen.gates.map((g) => g.id), ['screen.ocr', 'ocr', 'ocr-health'])
})
