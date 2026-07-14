import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Fabric, Flag, QueueFailure, WorkflowSpec } from '@openinfo/contracts'
import { evaluateSenseGates } from '../surfaces/settings/sense-gates.js'
import { senseLaneGateState } from './gates.js'

/**
 * #192 — the bridge from the REAL per-sense gate chain to the lane tracker's closed overlay. Every case
 * runs the actual evaluateSenseGates over honest flag/fabric/workflow inputs; nothing stubs a chain, so a
 * change to gate ordering or ids is caught here, not on a surface.
 */

const flag = (key: string, on: boolean): Flag => ({ key, default: on, scope: 'engine', description: 'test' })

const fabric = (over: Partial<Fabric['slots']> = {}): Fabric => ({
  slots: { stt: [], tts: [], llm: [], vlm: [], ocr: [], embed: [], ...over },
})

const endpoint = (name: string) => ({ kind: 'http', name, url: 'http://127.0.0.1:1', api: 'openai-compat' }) as Fabric['slots']['stt'][number]

const audioOn = [flag('distill.enabled', true), flag('distill.transcribe', true)]

test('a closed feature toggle maps to disabled for exactly its own lanes', () => {
  // Fresh-install truth: every processing flag off ⇒ every lane is deliberately off, and says so.
  assert.deepEqual(senseLaneGateState(evaluateSenseGates({ flags: [], fabric: fabric() })), {
    mic: 'disabled',
    'system-audio': 'disabled',
    screen: 'disabled',
  })

  // Audio on but screen.ocr off: only the screen lane reads disabled; the audio lanes name THEIR blocker.
  const state = senseLaneGateState(evaluateSenseGates({
    flags: audioOn,
    fabric: fabric({ stt: [endpoint('stt-live')] }),
  }))
  assert.deepEqual(state, { screen: 'disabled' })
})

test('missing required configuration maps to configuration-blocked, per lane', () => {
  // Flags on, slots empty: the true blocker is the missing model, not a toggle.
  assert.deepEqual(
    senseLaneGateState(evaluateSenseGates({ flags: [...audioOn, flag('screen.ocr', true)], fabric: fabric() })),
    { mic: 'configuration-blocked', 'system-audio': 'configuration-blocked', screen: 'configuration-blocked' },
  )
})

test('fully open gates leave every lane clear', () => {
  assert.deepEqual(
    senseLaneGateState(evaluateSenseGates({
      flags: [...audioOn, flag('screen.ocr', true)],
      fabric: fabric({ stt: [endpoint('stt-live')], ocr: [endpoint('ocr-live')] }),
    })),
    {},
  )
})

test('workflow screen ownership blocks honestly: missing document/step is configuration, an off step flag is disabled', () => {
  const flags = [...audioOn, flag('workflow.enabled', true)]
  const slots = fabric({ stt: [endpoint('stt-live')], ocr: [endpoint('ocr-live')], vlm: [endpoint('vlm-live')] })

  // workflow.enabled on but no active document supplied ⇒ the screen chain cannot be diagnosed ⇒ configuration.
  assert.deepEqual(senseLaneGateState(evaluateSenseGates({ flags, fabric: slots })), { screen: 'configuration-blocked' })

  // A document with no screen-recognition drain step is missing configuration.
  const noScreenStep: WorkflowSpec = { id: 'wf-test', name: 'wf', version: 1, steps: [{ id: 'step-distill', kind: 'distill', params: {} }] }
  assert.deepEqual(
    senseLaneGateState(evaluateSenseGates({ flags, fabric: slots, activeWorkflow: noScreenStep })),
    { screen: 'configuration-blocked' },
  )

  // Every screen step gated off by its own flag key ⇒ a deliberate off switch ⇒ disabled.
  const gatedOff: WorkflowSpec = {
    id: 'wf-test', name: 'wf', version: 1,
    steps: [{ id: 'step-vlm', kind: 'vlm', when: { flag: 'screen.vlm' }, params: {} }],
  }
  assert.deepEqual(
    senseLaneGateState(evaluateSenseGates({ flags, fabric: slots, activeWorkflow: gatedOff })),
    { screen: 'disabled' },
  )

  // The enabled VLM step with an occupied vlm slot is clear.
  assert.deepEqual(
    senseLaneGateState(evaluateSenseGates({
      flags: [...flags, flag('screen.vlm', true)],
      fabric: slots,
      activeWorkflow: gatedOff,
    })),
    {},
  )

  // The enabled VLM step against an EMPTY vlm slot is missing configuration.
  assert.deepEqual(
    senseLaneGateState(evaluateSenseGates({
      flags: [...flags, flag('screen.vlm', true)],
      fabric: fabric({ stt: [endpoint('stt-live')], ocr: [endpoint('ocr-live')] }),
      activeWorkflow: gatedOff,
    })),
    { screen: 'configuration-blocked' },
  )
})

test('runtime endpoint health never becomes a gate overlay — the lane keeps its own processing truth', () => {
  const lastFailure: QueueFailure = {
    class: 'unreachable', endpoint: 'stt-live', hint: 'start the local endpoint', at: '2026-07-14T10:00:00.000Z',
  }
  const chains = evaluateSenseGates({
    flags: [...audioOn, flag('screen.ocr', true)],
    fabric: fabric({ stt: [endpoint('stt-live')], ocr: [endpoint('ocr-live')] }),
    lastFailure,
  })
  // The chain honestly blocks at stt endpoint health…
  assert.equal(chains.find((chain) => chain.sense === 'mic')?.blocking?.id, 'stt-health')
  // …but the overlay stays deterministic configuration truth: no lane is relabeled by a transient failure.
  assert.deepEqual(senseLaneGateState(chains), {})
})
