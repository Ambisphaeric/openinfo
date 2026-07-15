import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk, Fabric, FieldValue, SessionAnnotation } from '@openinfo/contracts'
import { FabricDocuments } from '../fabric/index.js'
import { defaultFabric } from '../fabric/document.js'
import type { InvokeOptions, LlmMessage, LlmResult } from '../fabric/index.js'
import { WorkspaceRegistry } from '../store/index.js'
import { DistillDocuments } from './documents.js'
import { FieldValueStore } from './field-values.js'
import { JudgeScheduler, type OrientationDisposition } from './judge.js'
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
  opts: { withJudgeEndpoint?: boolean; orientationDisposition?: OrientationDisposition } = {},
): Promise<{
  store: WorkspaceRegistry
  scheduler: JudgeScheduler
  values: FieldValueStore
  published: FieldValue[]
  annotations: SessionAnnotation[]
  logs: string[]
  dir: string
}> => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-judge-'))
  const store = new WorkspaceRegistry(dir)
  const docs = new DistillDocuments(store)
  docs.ensureDefaults()
  const fabric = new FabricDocuments(store)
  if (opts.withJudgeEndpoint !== false) fabric.save(fabricWithJudge())
  const values = new FieldValueStore(store)
  const published: FieldValue[] = []
  const annotations: SessionAnnotation[] = []
  const logs: string[] = []
  const scheduler = new JudgeScheduler({
    store,
    fabric,
    docs,
    values,
    invoke,
    now: () => new Date('2026-07-09T12:01:00.000Z'),
    publish: (value) => void published.push(value),
    publishAnnotation: (annotation) => void annotations.push(annotation),
    log: (message) => void logs.push(message),
    ...(opts.orientationDisposition ? { orientationDisposition: opts.orientationDisposition } : {}),
  })
  return { store, scheduler, values, published, annotations, logs, dir }
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
  // The seeded set now includes the #131 orientation judge (single-input), so capture EVERY prompt and
  // assert the VERDICT judge's carries both inputs — not just messages[0] of the last invoke.
  const seenPrompts: string[] = []
  const invoke = async (messages: LlmMessage[]): Promise<LlmResult> => {
    seenPrompts.push(messages[0]!.content)
    return { text: '[]', endpoint: 'llm.judge', slot: 'llm' }
  }
  const { store, scheduler, values, dir } = await harness(invoke)
  try {
    seedValue(values, 'field-topic', 'topic', 'quarterly planning')
    await scheduler.runJudge([sourceChunk()])
    assert.ok(seenPrompts.some((p) => /launch-sequencing deck to Priya/.test(p)), 'the SOURCE transcript window is in a prompt')
    assert.ok(seenPrompts.some((p) => /fieldId: field-topic/.test(p)), 'the fast RESULT set is in the verdict prompt')
    assert.ok(seenPrompts.some((p) => /quarterly planning/.test(p)), 'the fast field value is in the verdict prompt')
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

test('#206: judge review provenance names only chunks in the exact capped source tail', async () => {
  const prompts: string[] = []
  const invoke = async (messages: LlmMessage[]): Promise<LlmResult> => {
    prompts.push(messages[0]!.content)
    return {
      text: JSON.stringify([{ fieldId: 'field-topic', verdict: 'confirm' }]),
      endpoint: 'llm.judge',
      slot: 'llm',
    }
  }
  const { store, scheduler, values, dir } = await harness(invoke)
  try {
    seedValue(values, 'field-topic', 'topic', 'quarterly planning')
    const older = chunk(0, `OLDER_JUDGE_SENTINEL_${'a'.repeat(100)}`)
    // The exact 8k source tail starts inside this chunk; keep the marker inside that material tail.
    const tail = chunk(1, `${'b'.repeat(9000)}_TAIL_JUDGE_SENTINEL`)
    const produced = await scheduler.runJudge([older, tail])
    assert.equal(produced.length, 1)
    assert.ok(prompts.every((prompt) => !prompt.includes('OLDER_JUDGE_SENTINEL')))
    assert.ok(prompts.every((prompt) => prompt.includes('TAIL_JUDGE_SENTINEL')))
    const review = values.latest(WS, 'field-topic', SESS)?.provenance.judge
    assert.deepEqual(review?.sourceChunks, ['c-1'])
    assert.equal(review?.windowStart, tail.capturedAt)
    assert.equal(review?.windowEnd, tail.capturedAt)
  } finally {
    await cleanup(store, dir)
  }
})

test('explainable-empty: no fast values to review → the verdict judge overrules nothing (no invoke on the review path)', async () => {
  // The VERDICT judge short-circuits BEFORE invoking when there is nothing to review; the seeded #131
  // orientation judge still classifies the source (its own invoke), so we assert the verdict PATH is empty
  // rather than a global zero-invoke count.
  let verdictInvokes = 0
  const invoke = async (messages: LlmMessage[]): Promise<LlmResult> => {
    if (/JSON array of verdicts/.test(messages[0]!.content)) verdictInvokes += 1
    return { text: '[]', endpoint: 'llm.judge', slot: 'llm' }
  }
  const { store, scheduler, published, dir } = await harness(invoke)
  try {
    const produced = await scheduler.runJudge([sourceChunk()]) // no fast values seeded
    assert.deepEqual(produced, [], 'the verdict judge overrules nothing')
    assert.equal(published.length, 0, 'no field.updated when there is nothing to review')
    assert.equal(verdictInvokes, 0, 'the verdict judge does not invoke when there is nothing to review')
  } finally {
    await cleanup(store, dir)
  }
})

// #131 orientation — the seeded orientation judge document classifies the session with NO fast values seeded
// (it reads the source, not the fast-result set), stamps an engine-owned SessionAnnotation, and emits it.
test('#131 orientation: classifies the session, engine-stamps the annotation, emits orientation.updated', async () => {
  const invoke = async (messages: LlmMessage[]): Promise<LlmResult> => {
    // The orientation prompt must carry the SOURCE window (single-input) and NOT the fast {{results}} block.
    assert.match(messages[0]!.content, /launch-sequencing deck to Priya/, 'the orientation prompt carries the source window')
    assert.doesNotMatch(messages[0]!.content, /fieldId:/, 'the orientation prompt does not carry the fast result set')
    return {
      text: JSON.stringify({ nature: 'meeting', direction: 'learn', topics: ['Q3 GTM launch sequencing', 'vendor security review'] }),
      endpoint: 'llm.judge',
      model: 'big-32b',
      slot: 'llm',
    }
  }
  const { store, scheduler, annotations, dir } = await harness(invoke)
  try {
    // Nothing seeded — orientation runs regardless of fast values (unlike the verdict path).
    const produced = await scheduler.runJudge([sourceChunk()])
    assert.deepEqual(produced, [], 'orientation does not overrule fast fields')
    const a = scheduler.latestAnnotation(WS, SESS)!
    assert.ok(a, 'an annotation was persisted')
    assert.equal(a.id, `oa:${WS}:${SESS}`, 'deterministic id ⇒ annotate-and-correct in place')
    assert.equal(a.workspaceId, WS)
    assert.equal(a.sessionId, SESS)
    assert.equal(a.nature, 'meeting')
    assert.equal(a.direction, 'learn')
    assert.deepEqual(a.topics, ['Q3 GTM launch sequencing', 'vendor security review'])
    assert.equal(a.provenance.templateId, 'tpl-judge-orientation', 'engine stamps which judge doc')
    assert.equal(a.provenance.endpoint, 'llm.judge')
    assert.equal(a.provenance.model, 'big-32b')
    assert.equal(a.provenance.classifiedAt, '2026-07-09T12:01:00.000Z', 'engine stamps the time, not the model')
    assert.equal(a.schemaVersion, 1)
    assert.equal(annotations.length, 1, 'orientation.updated emitted once')
    assert.equal(annotations[0]!.id, a.id)
  } finally {
    await cleanup(store, dir)
  }
})

// #131 annotate-and-correct — a later pass revises the earlier reading in place (same deterministic id).
test('#131 orientation: annotate-and-correct — a later classification replaces the earlier one in place', async () => {
  let call = 0
  const invoke = async (): Promise<LlmResult> => {
    call += 1
    const body = call === 1 ? { nature: 'unclear', direction: 'unclear', topics: [] } : { nature: 'call', direction: 'teach', topics: ['onboarding'] }
    return { text: JSON.stringify(body), endpoint: 'llm.judge', model: 'big-32b', slot: 'llm' }
  }
  const { store, scheduler, annotations, dir } = await harness(invoke)
  try {
    await scheduler.runJudge([sourceChunk()])
    await scheduler.runJudge([sourceChunk()])
    const a = scheduler.latestAnnotation(WS, SESS)!
    assert.equal(a.nature, 'call', 'the latest reading wins')
    assert.equal(a.direction, 'teach')
    assert.deepEqual(a.topics, ['onboarding'])
    assert.equal(annotations.length, 2, 'each pass emits orientation.updated')
  } finally {
    await cleanup(store, dir)
  }
})

// #131 no fabrication — a blank/absent classification defaults to the honest "unclear"; topics are engine-capped.
test('#131 orientation: blank fields default to "unclear"; topics are engine-capped, never count-inflated', async () => {
  const invoke = async (): Promise<LlmResult> => ({
    // Model omits direction, blanks nature, and floods topics — engine must not trust it.
    text: JSON.stringify({ nature: '  ', topics: ['a', 'b', 'c', 'd', 'e', 'f', 'g', '', '  '] }),
    endpoint: 'llm.judge',
    slot: 'llm',
  })
  const { store, scheduler, dir } = await harness(invoke)
  try {
    await scheduler.runJudge([sourceChunk()])
    const a = scheduler.latestAnnotation(WS, SESS)!
    assert.equal(a.nature, 'unclear', 'a blank nature is the honest "unclear", never invented')
    assert.equal(a.direction, 'unclear', 'an omitted direction is "unclear"')
    assert.equal(a.topics.length, 5, 'topics capped at the engine max — the model does not control counts')
    assert.deepEqual(a.topics, ['a', 'b', 'c', 'd', 'e'])
  } finally {
    await cleanup(store, dir)
  }
})

// #131 unparseable output is skipped-with-log; an earlier annotation (if any) is left in place — no fabrication.
test('#131 orientation: unparseable model output → no annotation, no emit', async () => {
  const invoke = async (): Promise<LlmResult> => ({ text: 'I could not classify this.', endpoint: 'llm.judge', slot: 'llm' })
  const { store, scheduler, annotations, dir } = await harness(invoke)
  try {
    await scheduler.runJudge([sourceChunk()])
    assert.equal(scheduler.latestAnnotation(WS, SESS), undefined, 'nothing persisted from unparseable output')
    assert.equal(annotations.length, 0, 'nothing emitted')
  } finally {
    await cleanup(store, dir)
  }
})

// #131 tier-gate — like the verdict judge, orientation is a no-op with no judge endpoint (nothing fabricated).
test('#131 orientation: tier-gated — no judge endpoint ⇒ no classification, no emit', async () => {
  let calls = 0
  const invoke = async (): Promise<LlmResult> => {
    calls += 1
    return { text: JSON.stringify({ nature: 'meeting', direction: 'learn', topics: [] }), endpoint: 'llm.judge', slot: 'llm' }
  }
  const { store, scheduler, annotations, dir } = await harness(invoke, { withJudgeEndpoint: false })
  try {
    await scheduler.runJudge([sourceChunk()])
    assert.equal(calls, 0, 'no invoke when tier-gated out')
    assert.equal(scheduler.latestAnnotation(WS, SESS), undefined)
    assert.equal(annotations.length, 0)
  } finally {
    await cleanup(store, dir)
  }
})

// #131 gate-ready seam — the 'gate' disposition is threaded end-to-end but not yet enforced: it still
// annotates (persist + emit) and logs the not-yet-enforced marker, so flipping the config later is the ONLY
// change needed. This pins the seam so a future gate flip does not silently re-architect.
test('#131 gate-ready seam: gate disposition annotates-and-logs (hold not yet enforced)', async () => {
  const invoke = async (): Promise<LlmResult> => ({
    text: JSON.stringify({ nature: 'solo-work', direction: 'unclear', topics: ['refactor'] }),
    endpoint: 'llm.judge',
    model: 'big-32b',
    slot: 'llm',
  })
  const { store, scheduler, annotations, logs, dir } = await harness(invoke, { orientationDisposition: 'gate' })
  try {
    await scheduler.runJudge([sourceChunk()])
    const a = scheduler.latestAnnotation(WS, SESS)!
    assert.equal(a.nature, 'solo-work', 'gate still annotates today (no half-built hold)')
    assert.equal(annotations.length, 1, 'orientation.updated still emitted under gate')
    assert.ok(logs.some((l) => /gate.*not yet enforced/i.test(l)), 'the seam logs that gate is not yet enforced')
  } finally {
    await cleanup(store, dir)
  }
})

test('#116: a review carries the judge pass spanId and the invoke usage', async () => {
  const invoke = async (): Promise<LlmResult> => ({
    text: JSON.stringify([
      { fieldId: 'field-topic', verdict: 'confirm' },
      { fieldId: 'field-entities', verdict: 'flag', note: 'thin evidence' },
    ]),
    endpoint: 'llm.judge',
    model: 'big-32b',
    slot: 'llm',
    usage: { estimated: false, promptTokens: 300, completionTokens: 40, totalTokens: 340 },
  })
  const { store, scheduler, values, dir } = await harness(invoke)
  try {
    seedValue(values, 'field-topic', 'topic', 'Q3 GTM launch sequencing')
    seedValue(values, 'field-entities', 'entities', 'Dana, Priya')
    const produced = await scheduler.runJudge([sourceChunk()])
    assert.equal(produced.length, 2)
    const topic = values.latest(WS, 'field-topic', SESS)!
    const entities = values.latest(WS, 'field-entities', SESS)!
    const spanId = topic.provenance.judge!.spanId
    assert.ok(spanId !== undefined && spanId.length > 0, 'the judge pass correlation id is stamped')
    assert.equal(entities.provenance.judge!.spanId, spanId, 'both verdicts of the same pass share the spanId')
    assert.equal(topic.provenance.judge!.usage?.promptTokens, 300, 'the judge invoke usage rides onto the review')
  } finally {
    await cleanup(store, dir)
  }
})
