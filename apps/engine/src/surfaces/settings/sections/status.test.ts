import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Endpoint, Fabric, Flag, QueueStatus, Session, WorkflowSpec } from '@openinfo/contracts'
import type { SetupData } from '../../setup/view.js'
import { renderStatus } from './status.js'

const emptyFabric = (): Fabric => ({ slots: { stt: [], tts: [], llm: [], vlm: [], ocr: [], embed: [] } })
const sttEndpoint = (name = 'whisper'): Endpoint => ({ kind: 'http', name, url: 'http://127.0.0.1:9001', api: 'openai-compat', model: 'whisper-1' })
const flag = (key: string, on: boolean): Flag => ({ key, default: on, scope: 'engine', description: key })
const vlmWorkflow: WorkflowSpec = {
  id: 'workflow-default',
  name: 'VLM screen',
  version: 1,
  steps: [{ id: 'screen-vlm', kind: 'vlm', slot: 'vlm', trigger: 'drain', when: { flag: 'screen.vlm' }, params: {} }],
}

const data = (over: Partial<SetupData> = {}): SetupData => ({
  profiles: [],
  activeId: undefined,
  liveFabric: emptyFabric(),
  editing: undefined,
  secretRefs: [],
  flags: [],
  ...over,
})

test('the Status section renders the per-sense Capture pipeline card', () => {
  const html = renderStatus(data())
  assert.match(html, /Capture pipeline/)
  // all three senses appear
  assert.match(html, /Microphone/)
  assert.match(html, /System audio/)
  assert.match(html, />Screen</)
})

test('with every flag off, the mic sense names distill.enabled as its blocker (never a bare "off")', () => {
  const html = renderStatus(data())
  assert.match(html, /blocked/)
  // the first blocking gate's human label + its one-step fix are shown
  assert.match(html, /Distill enabled/)
  assert.match(html, /Settings → Features/)
})

test('flags on + stt configured ⇒ the mic chain reads clear (no fabricated blocker)', () => {
  const fabric = emptyFabric()
  fabric.slots.stt = [sttEndpoint()]
  fabric.slots.ocr = [{ kind: 'http', name: 'paddle', url: 'http://127.0.0.1:9002', api: 'paddle-serving' }]
  const flags = [flag('distill.enabled', true), flag('distill.transcribe', true), flag('screen.ocr', true)]
  const html = renderStatus(data({ liveFabric: fabric, flags }))
  assert.match(html, /clear/)
})

test('a queue lastFailure on the stt endpoint surfaces as the health-gate blocker with its hint', () => {
  const fabric = emptyFabric()
  fabric.slots.stt = [sttEndpoint('whisper')]
  const flags = [flag('distill.enabled', true), flag('distill.transcribe', true)]
  const queue: QueueStatus = {
    pendingFiles: 1,
    pendingBytes: 10,
    drainedFiles: 0,
    updatedAt: new Date().toISOString(),
    lastFailure: { class: 'unreachable', endpoint: 'whisper', hint: 'Start the stt server on :9001', at: new Date().toISOString() },
  }
  const html = renderStatus(data({ liveFabric: fabric, flags, queue }))
  assert.match(html, /Start the stt server on :9001/)
})

const liveSession = (over: Partial<Session> = {}): Session => ({
  id: 'ses-abc123',
  workspaceId: 'default',
  modeId: 'mode-meeting',
  startedAt: '2026-07-07T14:16:00.000Z',
  attribution: { evidence: [], confidence: 1 },
  ...over,
})

test('#211 Status names the live session by its episode title, never its raw id', () => {
  const html = renderStatus(data({ liveSession: liveSession({ title: 'Meeting on Q3 launch' }) }))
  assert.match(html, /Meeting on Q3 launch/)
  assert.doesNotMatch(html, /ses-abc123/, 'the opaque id is not a name (hud-voice) — it must not render')
})

test('#211 an untitled live session shows an honest start-time fallback, not an id', () => {
  const html = renderStatus(data({ liveSession: liveSession() }))
  assert.doesNotMatch(html, /ses-abc123/, 'no raw id')
  assert.match(html, /started \d{1,2}:\d{2}/, 'a human start-time label stands in until a title is derived')
})

test('#211 no live session still reads honestly', () => {
  assert.match(renderStatus(data()), /no live session/)
})

test('#226 the live-session line never leaks the raw workspace id ("… in default")', () => {
  const html = renderStatus(data({ liveSession: liveSession({ title: 'Meeting on Q3 launch' }) }))
  assert.doesNotMatch(html, /in default/, 'a lone workspace needs no id disambiguation — omitted, never machinery')
  assert.match(html, /Meeting on Q3 launch/, 'the human episode name still stands')
})

test('workflow-mode Status names the active VLM slot instead of the legacy OCR slot', () => {
  const fabric = emptyFabric()
  fabric.slots.vlm = [{ kind: 'http', name: 'vision', url: 'http://127.0.0.1:9003', api: 'openai-compat', model: 'gemma-3-12b' }]
  const flags = [flag('workflow.enabled', true), flag('screen.vlm', true)]
  const html = renderStatus(data({ liveFabric: fabric, flags, activeWorkflow: vlmWorkflow }))
  assert.match(html, /Workflow vision step enabled/)
  assert.match(html, /Vision \(vlm\) endpoint/)
  assert.doesNotMatch(html, /Reading \(ocr\) endpoint/)
})
