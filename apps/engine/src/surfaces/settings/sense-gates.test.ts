import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Endpoint, Fabric, Flag, QueueFailure } from '@openinfo/contracts'
import type { EndpointHealth } from '../../fabric/health.js'
import { evaluateSenseGates, type CaptureSense, type SenseGateChain, type SenseGateInput } from './sense-gates.js'

const emptyFabric = (): Fabric => ({ slots: { stt: [], tts: [], llm: [], vlm: [], ocr: [], embed: [] } })

const sttEndpoint = (name = 'whisper'): Endpoint => ({ kind: 'http', name, url: 'http://127.0.0.1:9001', api: 'openai-compat', model: 'whisper-1' })
const ocrEndpoint = (name = 'paddle'): Endpoint => ({ kind: 'http', name, url: 'http://127.0.0.1:9002', api: 'paddle-serving' })

const flag = (key: string, on: boolean): Flag => ({ key, default: on, scope: 'engine', description: key })

/** All-off flags (the engine default — every flag default:false). */
const allOff: Flag[] = ['distill.enabled', 'distill.transcribe', 'screen.ocr'].map((k) => flag(k, false))
const withFlags = (on: string[]): Flag[] => ['distill.enabled', 'distill.transcribe', 'screen.ocr'].map((k) => flag(k, on.includes(k)))

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

test('every chain exposes its ordered gates so the readout can show the whole pipeline', () => {
  const mic = bySense(run(), 'mic')
  assert.deepEqual(mic.gates.map((g) => g.id), ['distill.enabled', 'distill.transcribe', 'stt', 'stt-health'])
  const screen = bySense(run(), 'screen')
  assert.deepEqual(screen.gates.map((g) => g.id), ['screen.ocr', 'ocr', 'ocr-health'])
})
