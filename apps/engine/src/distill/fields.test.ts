import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { BlockQuery, CaptureChunk, FieldValue } from '@openinfo/contracts'
import { FabricDocuments } from '../fabric/index.js'
import type { InvokeOptions, LlmMessage, LlmResult } from '../fabric/index.js'
import { WorkspaceRegistry } from '../store/index.js'
import { VoiceDocuments } from '../voice/index.js'
import { compileQuery } from '../surfaces/query.js'
import { DistillDocuments } from './documents.js'
import { FieldValueStore } from './field-values.js'
import { FastFieldScheduler } from './fields.js'

const WS = 'ws-fields'
const SESS = 'sess-fields'

/** Build a scheduler over a fresh temp store with the shipped defaults seeded + an injected fake llm. */
const harness = async (
  invoke: (messages: LlmMessage[], opts: InvokeOptions) => Promise<LlmResult>,
): Promise<{ store: WorkspaceRegistry; scheduler: FastFieldScheduler; values: FieldValueStore; published: FieldValue[]; dir: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-fields-'))
  const store = new WorkspaceRegistry(dir)
  const voice = new VoiceDocuments(store)
  voice.ensureDefaults()
  const docs = new DistillDocuments(store)
  docs.ensureDefaults()
  const fabric = new FabricDocuments(store)
  const values = new FieldValueStore(store)
  const published: FieldValue[] = []
  const scheduler = new FastFieldScheduler({
    store,
    voice,
    fabric,
    docs,
    values,
    invoke,
    publish: (value) => void published.push(value),
  })
  return { store, scheduler, values, published, dir }
}

/** One text chunk `sec` seconds into a fixed base — `data` controls the material length (the gate input). */
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

/** Material comfortably over the largest default gate (work-items = 80 chars) so all three fields trigger. */
const richChunk = (): CaptureChunk =>
  chunk(
    0,
    'We agreed Dana will send the Q3 deck to Priya by Friday and schedule the vendor security review for next week.',
  )

test('fan-out runs N triggered fast-field prompts CONCURRENTLY against the llm slot', async () => {
  let inFlight = 0
  let maxInFlight = 0
  const invoke = async (messages: LlmMessage[]): Promise<LlmResult> => {
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((r) => setTimeout(r, 15)) // hold the lane open so overlap is observable
    inFlight -= 1
    return { text: 'answer', endpoint: 'fake-fast', model: 'tiny-1b', slot: 'llm' }
  }
  const { store, scheduler, published, dir } = await harness(invoke)
  try {
    const produced = await scheduler.runFields([richChunk()])
    // Three shipped fast fields, all over their gate → three concurrent invokes (sequential would cap at 1).
    assert.equal(produced.length, 3)
    assert.equal(maxInFlight, 3, 'all three fields must be in flight at once (Promise.all fan-out)')
    assert.equal(published.length, 3)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the relevance gate counts observed text, never machine-owned physical-label length', async () => {
  const prompts: string[] = []
  const invoke = async (messages: LlmMessage[]): Promise<LlmResult> => {
    prompts.push(messages[0]!.content)
    return { text: 'answer', endpoint: 'fake-fast', model: 'tiny-1b', slot: 'llm' }
  }
  const { store, scheduler, dir } = await harness(invoke)
  try {
    // 50 observed chars: topic (40) triggers; entities (60) and work-items (80) stay gated out even though
    // the prompt adds the longer `microphone: ` machine label (which would otherwise push it over 60).
    const produced = await scheduler.runFields([chunk(0, 'x'.repeat(50))])
    assert.equal(produced.length, 1, 'only the topic field clears a 50-char window')
    assert.equal(prompts.length, 1, 'gated fields never reach the llm slot — no wasted invoke')
    assert.equal(produced[0]!.fieldId, 'field-topic')
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('nothing triggers below every gate → no invoke, explainable-empty', async () => {
  let calls = 0
  const invoke = async (): Promise<LlmResult> => {
    calls += 1
    return { text: 'answer', endpoint: 'fake-fast', slot: 'llm' }
  }
  const { store, scheduler, dir } = await harness(invoke)
  try {
    const produced = await scheduler.runFields([chunk(0, 'hi')]) // 2 chars, under every gate
    assert.deepEqual(produced, [])
    assert.equal(calls, 0)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('each result persists as the field latest value AND carries real provenance + provisional state', async () => {
  const invoke = async (messages: LlmMessage[]): Promise<LlmResult> => {
    const prompt = messages[0]!.content
    const text = prompt.includes('Topic:') ? 'Q3 planning' : prompt.includes('Entities:') ? 'Dana, Priya, Q3 deck' : 'Send the Q3 deck to Priya'
    return { text, endpoint: 'this-mac', model: 'qwen2.5-7b', slot: 'llm' }
  }
  const { store, scheduler, values, dir } = await harness(invoke)
  try {
    const produced = await scheduler.runFields([richChunk()])
    assert.equal(produced.length, 3)

    // Persistence round-trip: the store's latest value for each field is exactly what was produced.
    const topic = values.latest(WS, 'field-topic', SESS)
    assert.ok(topic, 'topic field value persisted')
    assert.equal(topic!.value, 'Q3 planning')
    assert.equal(topic!.state, 'provisional', 'fast results are provisional by definition (#66)')
    assert.equal(topic!.provenance.endpoint, 'this-mac')
    assert.equal(topic!.provenance.model, 'qwen2.5-7b')
    assert.equal(topic!.provenance.templateId, 'tpl-field-topic')
    assert.equal(topic!.provenance.slot, 'llm')
    assert.ok(topic!.provenance.windowStart && topic!.provenance.windowEnd, 'provenance carries the material window')
    assert.equal(topic!.label, 'topic')

    // A second pass REPLACES the latest value (versioned in place, keyed deterministically by scope).
    await scheduler.runFields([richChunk()])
    const list = values.list(WS, SESS)
    assert.equal(list.length, 3, 'still one current value per field after a re-run (not duplicated)')
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a per-field invoke failure is isolated — no fabricated value, the other fields still land', async () => {
  const invoke = async (messages: LlmMessage[]): Promise<LlmResult> => {
    if (messages[0]!.content.includes('Work items:')) throw new Error('model exploded on work-items')
    return { text: 'ok', endpoint: 'fake-fast', model: 'tiny-1b', slot: 'llm' }
  }
  const { store, scheduler, values, published, dir } = await harness(invoke)
  try {
    const produced = await scheduler.runFields([richChunk()])
    assert.equal(produced.length, 2, 'two fields survive the third field failing')
    assert.equal(published.length, 2, 'no field.updated for the failed field')
    assert.equal(values.latest(WS, 'field-work-items', SESS), undefined, 'no fabricated value persisted for the failed field')
    assert.ok(values.latest(WS, 'field-topic', SESS), 'topic still landed')
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the fields query source hydrates the current field values with provenance, freshest first', async () => {
  const invoke = async (messages: LlmMessage[]): Promise<LlmResult> => {
    const text = messages[0]!.content.includes('Topic:') ? 'Q3 planning' : messages[0]!.content.includes('Entities:') ? 'Dana, Priya' : 'Send the deck'
    return { text, endpoint: 'this-mac', model: 'qwen2.5-7b', slot: 'llm' }
  }
  const { store, scheduler, dir } = await harness(invoke)
  try {
    await scheduler.runFields([richChunk()])
    const query: BlockQuery = { source: 'fields', params: { workspace: WS, session: SESS } }
    const result = compileQuery(store, query)
    assert.equal(result.source, 'fields')
    assert.equal(result.items.length, 3)
    const rows = result.items as FieldValue[]
    for (const row of rows) {
      assert.ok(row.provenance.endpoint, 'every rendered value carries provenance (no fake states)')
      assert.equal(row.state, 'provisional')
    }
    assert.ok(rows.map((r) => r.fieldId).includes('field-topic'))
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
