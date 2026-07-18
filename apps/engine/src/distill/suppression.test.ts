import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk } from '@openinfo/contracts'
import { FabricDocuments } from '../fabric/index.js'
import { WorkspaceRegistry } from '../store/index.js'
import { VoiceDocuments } from '../voice/index.js'
import { Distiller, type LlmInvoke } from './distiller.js'
import { DistillDocuments } from './documents.js'
import { NOTHING_NOTEWORTHY } from './defaults.js'

/**
 * Silence over noise (#245): a window with nothing worth noting must persist NO distillate. Two layers are
 * proven here against the real Distiller with an injected model:
 *   (a) the deterministic pre-gate — a window below the meaningful-character floor is dropped WITHOUT ever
 *       calling the model (cheap), so no distillate/moment/entity is produced.
 *   (b) the model sentinel — a window that clears the floor but comes back as the exact NOTHING_NOTEWORTHY
 *       token is dropped; a sentinel embedded INSIDE a real note is kept; a normal note is kept.
 */

const WS = 'default'

const speech = (sequence: number, data: string): CaptureChunk => ({
  id: `sp-${sequence}`,
  sessionId: 'ses-s',
  workspaceId: WS,
  source: 'mic',
  sequence,
  capturedAt: new Date(Date.UTC(2026, 6, 17, 14, 0, sequence)).toISOString(),
  contentType: 'text/plain',
  encoding: 'utf8',
  data,
})

interface Harness {
  dir: string
  store: WorkspaceRegistry
  distiller: Distiller
  invokeCount: () => number
  /** swap the summary-pass response mid-test (e.g. one dropped window then one kept). */
  setResponse: (r: string) => void
}

/** Build a Distiller whose model returns `response` for the summary pass (mutable via setResponse). */
const setup = async (response: string): Promise<Harness> => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-distill-suppress-'))
  const store = new WorkspaceRegistry(dir)
  const voice = new VoiceDocuments(store)
  voice.ensureDefaults()
  const docs = new DistillDocuments(store)
  docs.ensureDefaults()
  const fabric = new FabricDocuments(store)
  let calls = 0
  let current = response
  const invoke: LlmInvoke = (messages) => {
    calls++
    // Extraction passes (strict-JSON grammars) must not choke this summary-focused harness: hand them an
    // empty array; the summary pass gets the configured response.
    const prompt = messages[0]!.content
    const isExtraction = prompt.includes('JSON array')
    return Promise.resolve({ text: isExtraction ? '[]' : current, slot: 'llm', endpoint: 'fake-local' })
  }
  const distiller = new Distiller({ store, voice, docs, fabric, invoke })
  return { dir, store, distiller, invokeCount: () => calls, setResponse: (r: string) => { current = r } }
}

const teardown = async (h: Harness): Promise<void> => {
  h.store.close()
  await rm(h.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}

test('#245 pre-gate: a sub-threshold window persists NO distillate and never calls the model', async () => {
  const h = await setup('this should never be reached')
  try {
    // "um, yeah" trims to 8 chars < the 12-char floor.
    const produced = await h.distiller.distillChunks([speech(1, 'um, yeah')])
    assert.equal(produced.length, 0, 'no distillate returned')
    assert.deepEqual(h.store.listDistillates(WS), [], 'nothing persisted')
    assert.equal(h.invokeCount(), 0, 'the model was never invoked (cheap deterministic gate)')
  } finally {
    await teardown(h)
  }
})

test('#245 pre-gate: a real short utterance CLEARS the floor and produces a note (no false suppression)', async () => {
  const h = await setup('Ship Thursday.')
  try {
    // "We ship Thursday." is a meaningful 17-char sentence — it must NOT be silenced by the floor.
    const produced = await h.distiller.distillChunks([speech(1, 'We ship Thursday.')])
    assert.equal(produced.length, 1, 'a real short utterance still produces a note')
    assert.equal(h.store.listDistillates(WS).length, 1)
  } finally {
    await teardown(h)
  }
})

test('#245 sentinel: an exact NOTHING_NOTEWORTHY response drops the distillate', async () => {
  const h = await setup(NOTHING_NOTEWORTHY)
  try {
    const produced = await h.distiller.distillChunks([speech(1, 'so, um, are we... is this the meeting or, uh')])
    assert.equal(h.invokeCount(), 1, 'the window cleared the floor, so the model was consulted')
    assert.equal(produced.length, 0, 'the sentinel dropped the distillate')
    assert.deepEqual(h.store.listDistillates(WS), [], 'nothing persisted on the sentinel')
  } finally {
    await teardown(h)
  }
})

test('#245 sentinel: leading/trailing whitespace around the exact token still drops', async () => {
  const h = await setup(`\n  ${NOTHING_NOTEWORTHY}  \n`)
  try {
    const produced = await h.distiller.distillChunks([speech(1, 'so, um, are we... is this the meeting or, uh')])
    assert.equal(produced.length, 0, 'a trimmed exact match drops')
    assert.deepEqual(h.store.listDistillates(WS), [])
  } finally {
    await teardown(h)
  }
})

test('#245 sentinel: the token embedded INSIDE a real note does NOT drop (only the whole trimmed response counts)', async () => {
  const note = `We discussed ${NOTHING_NOTEWORTHY} as a placeholder token.`
  const h = await setup(note)
  try {
    const produced = await h.distiller.distillChunks([speech(1, 'we talked about the placeholder token today')])
    assert.equal(produced.length, 1, 'an embedded sentinel is kept — it is a real note')
    assert.equal(h.store.listDistillates(WS)[0]!.text, note)
  } finally {
    await teardown(h)
  }
})

test('#245 sentinel: a normal note is persisted unchanged', async () => {
  const h = await setup('Feedback to QA — due soon.')
  try {
    const produced = await h.distiller.distillChunks([speech(1, 'I need to provide feedback to QA in eighteen minutes')])
    assert.equal(produced.length, 1)
    assert.equal(h.store.listDistillates(WS)[0]!.text, 'Feedback to QA — due soon.')
  } finally {
    await teardown(h)
  }
})

test('#245: a dropped window produces no moments and no entities either (suppression is whole-window)', async () => {
  const h = await setup(NOTHING_NOTEWORTHY)
  try {
    await h.distiller.distillChunks([speech(1, 'so, um, are we... is this the meeting or, uh')], { extractMoments: true, extractEntities: true })
    assert.deepEqual(h.store.listDistillates(WS), [], 'no distillate')
    assert.deepEqual(h.store.listMoments(WS), [], 'no moments extracted from a dropped window')
    assert.equal(h.invokeCount(), 1, 'only the summary pass ran; extraction was skipped once the window was dropped')
  } finally {
    await teardown(h)
  }
})

test('#245 D2: a whitespace-only / empty model response is dropped (the most literal "nothing")', async () => {
  const h = await setup('   \n\t  ')
  try {
    const produced = await h.distiller.distillChunks([speech(1, 'so, um, are we... is this the meeting or, uh')])
    assert.equal(produced.length, 0, 'an empty/whitespace response never becomes an empty-text distillate')
    assert.deepEqual(h.store.listDistillates(WS), [])
  } finally {
    await teardown(h)
  }
})

test('#245 D4: sentinel strictness is deliberate — a trailing period or a lowercase variant is KEPT', async () => {
  // Trailing punctuation: not the exact token, so it is a (short) real note and is kept.
  const withPeriod = `${NOTHING_NOTEWORTHY}.`
  const h1 = await setup(withPeriod)
  try {
    const produced = await h1.distiller.distillChunks([speech(1, 'we talked about the placeholder token today')])
    assert.equal(produced.length, 1, 'a trailing period is not the exact sentinel — kept')
    assert.equal(h1.store.listDistillates(WS)[0]!.text, withPeriod)
  } finally {
    await teardown(h1)
  }
  // Lowercase: case-sensitive match, so a lowercased token is not the sentinel — kept.
  const lower = NOTHING_NOTEWORTHY.toLowerCase()
  const h2 = await setup(lower)
  try {
    const produced = await h2.distiller.distillChunks([speech(1, 'we talked about the placeholder token today')])
    assert.equal(produced.length, 1, 'a lowercase variant is not the exact sentinel — kept')
    assert.equal(h2.store.listDistillates(WS)[0]!.text, lower)
  } finally {
    await teardown(h2)
  }
})

test('#245 D4: a sentinel-dropped window does not poison the next — a following normal window persists', async () => {
  const h = await setup(NOTHING_NOTEWORTHY)
  try {
    // Window 1: nothing worth noting → dropped.
    const first = await h.distiller.distillChunks([speech(1, 'so, um, are we... is this the meeting or, uh')])
    assert.equal(first.length, 0, 'first window dropped')
    assert.deepEqual(h.store.listDistillates(WS), [], 'nothing persisted yet')
    // Window 2: real content → persisted normally, unaffected by the earlier drop.
    h.setResponse('Ship date confirmed for Thursday.')
    const second = await h.distiller.distillChunks([speech(2, 'okay so we are confirming the ship date for Thursday')])
    assert.equal(second.length, 1, 'second window persists normally')
    const stored = h.store.listDistillates(WS)
    assert.equal(stored.length, 1, 'exactly one distillate — only the second window')
    assert.equal(stored[0]!.text, 'Ship date confirmed for Thursday.')
  } finally {
    await teardown(h)
  }
})
