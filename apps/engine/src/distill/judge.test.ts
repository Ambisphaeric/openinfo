import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk, Fabric, FieldValue } from '@openinfo/contracts'
import { FabricDocuments } from '../fabric/index.js'
import { defaultFabric } from '../fabric/document.js'
import type { InvokeOptions, LlmMessage, LlmResult } from '../fabric/index.js'
import { WorkspaceRegistry } from '../store/index.js'
import { DistillDocuments } from './documents.js'
import { FieldValueStore } from './field-values.js'
import { JudgeScheduler } from './judge.js'
import { FIELD_VALUE_SCHEMA_VERSION } from '@openinfo/contracts'

const WS = 'ws-judge'
const SESS = 'sess-judge'

/** A fabric whose llm slot carries a judge-designated endpoint (the tier-gate positive case). */
const fabricWithJudge = (): Fabric => ({
  slots: { ...defaultFabric().slots, llm: [{ kind: 'http', name: 'llm.judge', url: 'http://127.0.0.1:9', api: 'openai-compat', model: 'big-32b' }] },
})

/** Seed a provisional fast-field value for `fieldId` so the judge has something to review. */
const seedValue = (values: FieldValueStore, fieldId: string, label: string, value: string): FieldValue => {
  const v: FieldValue = {
    id: FieldValueStore.idFor(WS, fieldId, SESS),
    fieldId,
    workspaceId: WS,
    sessionId: SESS,
    label,
    value,
    state: 'provisional',
    provenance: { templateId: `tpl-${fieldId}`, slot: 'llm', endpoint: 'llm.fast', model: 'tiny-1b', windowStart: '2026-07-09T12:00:00.000Z', windowEnd: '2026-07-09T12:00:30.000Z' },
    updatedAt: '2026-07-09T12:00:31.000Z',
    schemaVersion: FIELD_VALUE_SCHEMA_VERSION,
  }
  return values.put(v)
}

const harness = async (
  invoke: (messages: LlmMessage[], opts: InvokeOptions) => Promise<LlmResult>,
  opts: { withJudgeEndpoint?: boolean } = {},
): Promise<{ store: WorkspaceRegistry; scheduler: JudgeScheduler; values: FieldValueStore; published: FieldValue[]; dir: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-judge-'))
  const store = new WorkspaceRegistry(dir)
  const docs = new DistillDocuments(store)
  docs.ensureDefaults()
  const fabric = new FabricDocuments(store)
  if (opts.withJudgeEndpoint !== false) fabric.save(fabricWithJudge())
  const values = new FieldValueStore(store)
  const published: FieldValue[] = []
  const scheduler = new JudgeScheduler({
    store,
    fabric,
    docs,
    values,
    invoke,
    now: () => new Date('2026-07-09T12:01:00.000Z'),
    publish: (value) => void published.push(value),
  })
  return { store, scheduler, values, published, dir }
}

const chunk = (sec: number, data: string): CaptureChunk => ({
  id: `c-${sec}`,
  sessionId: SESS,
  workspaceId: WS,
  source: 'mic',
  sequence: sec,
  capturedAt: new Date(Date.UTC(2026, 6, 9, 12, 0, sec)).toISOString(),
  contentType: 'text/plain',
  encoding: 'utf8',
  data,
})

/** Material comfortably over the judge gate; the judge does not gate on minChars itself (that's fast). */
const sourceChunk = (): CaptureChunk =>
  chunk(0, 'We agreed Dana will send the Q3 GTM launch-sequencing deck to Priya by Friday and schedule the vendor security review for next week.')

const cleanup = async (store: WorkspaceRegistry, dir: string): Promise<void> => {
  store.close()
  await rm(dir, { recursive: true, force: true })
}

test('tier-gate: no judge endpoint in the fabric → no-op, fields stay provisional (degradation, not failure)', async () => {
  let calls = 0
  const invoke = async (): Promise<LlmResult> => {
    calls += 1
    return { text: '[]', endpoint: 'llm.judge', slot: 'llm' }
  }
  const { store, scheduler, values, dir } = await harness(invoke, { withJudgeEndpoint: false })
  try {
    seedValue(values, 'field-topic', 'topic', 'quarterly planning')
    assert.equal(scheduler.hasJudgeEndpoint(), false)
    const produced = await scheduler.runJudge([sourceChunk()])
    assert.deepEqual(produced, [])
    assert.equal(calls, 0, 'no invoke when tier-gated out')
    assert.equal(values.latest(WS, 'field-topic', SESS)!.state, 'provisional', 'field is untouched — still provisional')
  } finally {
    await cleanup(store, dir)
  }
})

test('confirm: the value stands, state → confirmed, judge provenance stamped, fast lineage preserved', async () => {
  const invoke = async (): Promise<LlmResult> => ({
    text: JSON.stringify([{ fieldId: 'field-topic', verdict: 'confirm' }]),
    endpoint: 'llm.judge',
    model: 'big-32b',
    slot: 'llm',
  })
  const { store, scheduler, values, published, dir } = await harness(invoke)
  try {
    seedValue(values, 'field-topic', 'topic', 'Q3 GTM launch sequencing')
    const produced = await scheduler.runJudge([sourceChunk()])
    assert.equal(produced.length, 1)
    const topic = values.latest(WS, 'field-topic', SESS)!
    assert.equal(topic.state, 'confirmed')
    assert.equal(topic.value, 'Q3 GTM launch sequencing', 'confirm leaves the value unchanged')
    assert.equal(topic.provenance.endpoint, 'llm.fast', 'fast lineage preserved on top-level provenance')
    assert.ok(topic.provenance.judge, 'judge stamp present')
    assert.equal(topic.provenance.judge!.verdict, 'confirm')
    assert.equal(topic.provenance.judge!.templateId, 'tpl-judge-default')
    assert.equal(topic.provenance.judge!.endpoint, 'llm.judge')
    assert.equal(topic.provenance.judge!.model, 'big-32b')
    assert.equal(topic.provenance.judge!.priorState, 'provisional')
    assert.equal(published.length, 1, 'field.updated republished for the transition')
  } finally {
    await cleanup(store, dir)
  }
})

test('correct: the value is OVERRULED in place, priorValue recorded, state → corrected', async () => {
  const invoke = async (): Promise<LlmResult> => ({
    text: JSON.stringify([{ fieldId: 'field-topic', verdict: 'correct', value: 'Q3 GTM launch sequencing', note: 'fast tier was too generic' }]),
    endpoint: 'llm.judge',
    model: 'big-32b',
    slot: 'llm',
  })
  const { store, scheduler, values, dir } = await harness(invoke)
  try {
    seedValue(values, 'field-topic', 'topic', 'quarterly planning')
    const produced = await scheduler.runJudge([sourceChunk()])
    assert.equal(produced.length, 1)
    const topic = values.latest(WS, 'field-topic', SESS)!
    assert.equal(topic.state, 'corrected')
    assert.equal(topic.value, 'Q3 GTM launch sequencing', 'value overruled in place')
    assert.equal(topic.provenance.judge!.verdict, 'correct')
    assert.equal(topic.provenance.judge!.priorValue, 'quarterly planning', 'the overruled value is recorded (what changed)')
    assert.equal(topic.provenance.judge!.note, 'fast tier was too generic')
  } finally {
    await cleanup(store, dir)
  }
})

test('flag: state → flagged with the judge note, value unchanged', async () => {
  const invoke = async (): Promise<LlmResult> => ({
    text: JSON.stringify([{ fieldId: 'field-work-items', verdict: 'flag', note: 'source too thin to confirm the owner' }]),
    endpoint: 'llm.judge',
    model: 'big-32b',
    slot: 'llm',
  })
  const { store, scheduler, values, dir } = await harness(invoke)
  try {
    seedValue(values, 'field-work-items', 'work-items', 'Send the deck')
    await scheduler.runJudge([sourceChunk()])
    const wi = values.latest(WS, 'field-work-items', SESS)!
    assert.equal(wi.state, 'flagged')
    assert.equal(wi.value, 'Send the deck', 'flag leaves the value unchanged')
    assert.equal(wi.provenance.judge!.note, 'source too thin to confirm the owner')
  } finally {
    await cleanup(store, dir)
  }
})

test('dual-input: the judge prompt receives BOTH the source transcript AND the fast result set', async () => {
  let seen = ''
  const invoke = async (messages: LlmMessage[]): Promise<LlmResult> => {
    seen = messages[0]!.content
    return { text: '[]', endpoint: 'llm.judge', slot: 'llm' }
  }
  const { store, scheduler, values, dir } = await harness(invoke)
  try {
    seedValue(values, 'field-topic', 'topic', 'quarterly planning')
    await scheduler.runJudge([sourceChunk()])
    assert.match(seen, /launch-sequencing deck to Priya/, 'the SOURCE transcript window is in the prompt')
    assert.match(seen, /fieldId: field-topic/, 'the fast RESULT set is in the prompt')
    assert.match(seen, /quarterly planning/, 'the fast field value is in the prompt')
  } finally {
    await cleanup(store, dir)
  }
})

test('no fabrication: a "correct" with no value is left unchanged; a verdict for an unknown field is ignored', async () => {
  const invoke = async (): Promise<LlmResult> => ({
    text: JSON.stringify([
      { fieldId: 'field-topic', verdict: 'correct' }, // no value → cannot apply
      { fieldId: 'field-nonexistent', verdict: 'confirm' }, // unknown → ignored
    ]),
    endpoint: 'llm.judge',
    slot: 'llm',
  })
  const { store, scheduler, values, published, dir } = await harness(invoke)
  try {
    seedValue(values, 'field-topic', 'topic', 'quarterly planning')
    const produced = await scheduler.runJudge([sourceChunk()])
    assert.deepEqual(produced, [], 'nothing overruled')
    assert.equal(published.length, 0)
    assert.equal(values.latest(WS, 'field-topic', SESS)!.state, 'provisional', 'unchanged — no invented correction')
  } finally {
    await cleanup(store, dir)
  }
})

test('a judge invoke failure is caught — returns [], the fields are untouched', async () => {
  const invoke = async (): Promise<LlmResult> => {
    throw new Error('judge model exploded')
  }
  const { store, scheduler, values, dir } = await harness(invoke)
  try {
    seedValue(values, 'field-topic', 'topic', 'quarterly planning')
    const produced = await scheduler.runJudge([sourceChunk()])
    assert.deepEqual(produced, [])
    assert.equal(values.latest(WS, 'field-topic', SESS)!.state, 'provisional')
  } finally {
    await cleanup(store, dir)
  }
})

test('explainable-empty: no fast values to review → no invoke, no error', async () => {
  let calls = 0
  const invoke = async (): Promise<LlmResult> => {
    calls += 1
    return { text: '[]', endpoint: 'llm.judge', slot: 'llm' }
  }
  const { store, scheduler, dir } = await harness(invoke)
  try {
    const produced = await scheduler.runJudge([sourceChunk()]) // nothing seeded
    assert.deepEqual(produced, [])
    assert.equal(calls, 0, 'the judge does not invoke when there is nothing to review')
  } finally {
    await cleanup(store, dir)
  }
})
