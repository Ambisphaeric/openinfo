import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Distillate, FieldValue, GuardHold, Moment, OcrResult, Session, SessionAnnotation, SttSegment, TodoList } from '@openinfo/contracts'
import { TodoDocuments } from '../act/todo.js'
import { FieldValueStore } from '../distill/field-values.js'
import { GuardHoldStore } from '../guard/documents.js'
import { buildTrace } from '../surfaces/settings/sections/trace.js'
import type { VersionedDocument } from './layouts.js'
import { WorkspaceRegistry } from './workspaces.js'

const SESSION_ID = 'ses-1'
const FROM = 'ws-a'
const TO = 'ws-b'
const FIELD_KIND = 'field-value'
const ANNOTATION_KIND = 'session-annotation'
const TODO_KIND = 'todo-list'
const FIELD_ID = 'field-topic'
const SOURCE_FIELD_KEY = FieldValueStore.idFor(FROM, FIELD_ID, SESSION_ID)
const DEST_FIELD_KEY = FieldValueStore.idFor(TO, FIELD_ID, SESSION_ID)
const SOURCE_ANNOTATION_KEY = `oa:${FROM}:${SESSION_ID}`
const DEST_ANNOTATION_KEY = `oa:${TO}:${SESSION_ID}`
const dials = { tone: 5, warmth: 5, wit: 5, charm: 5, specificity: 5, brevity: 5 }

const session = (): Session => ({
  id: SESSION_ID,
  workspaceId: FROM,
  modeId: 'mode-meeting',
  startedAt: '2026-07-14T12:00:00.000Z',
  endedAt: '2026-07-14T12:30:00.000Z',
  attribution: { evidence: [], confidence: 1 },
})

const segment = (): SttSegment => ({
  id: 'seg-1',
  workspaceId: FROM,
  sessionId: SESSION_ID,
  chunkId: 'chunk-1',
  spanId: 'span-stt',
  source: 'mic',
  capturedAt: '2026-07-14T12:00:00.000Z',
  processedAt: '2026-07-14T12:00:01.000Z',
  textChars: 42,
  provenance: { slot: 'stt', endpoint: 'whisper-local', model: 'whisper-large-v3' },
  schemaVersion: 1,
  createdAt: '2026-07-14T12:00:01.000Z',
})

const distillate = (): Distillate => ({
  id: 'distillate-1',
  sessionId: SESSION_ID,
  workspaceId: FROM,
  windowStart: '2026-07-14T12:00:00.000Z',
  windowEnd: '2026-07-14T12:00:15.000Z',
  sourceChunks: ['chunk-1'],
  spanId: 'span-window',
  text: 'The team agreed to ship the reroute repair.',
  voice: { scope: 'mode', dials },
  provenance: { slot: 'llm', endpoint: 'llm.fast', model: 'qwen-local' },
  schemaVersion: 1,
  createdAt: '2026-07-14T12:00:16.000Z',
})

const moment = (): Moment => ({
  id: 'moment-1',
  sessionId: SESSION_ID,
  workspaceId: FROM,
  at: '2026-07-14T12:00:15.000Z',
  kind: 'decision',
  text: 'Ship the reroute repair.',
  refs: [],
  source: 'mic',
  confidence: 0.9,
  spanId: 'span-window',
  provenance: { distillateId: 'distillate-1', slot: 'llm', endpoint: 'moment.local' },
})

const ocr = (): OcrResult => ({
  id: 'ocr-1',
  sessionId: SESSION_ID,
  workspaceId: FROM,
  sourceChunks: ['frame-1'],
  spanId: 'span-screen',
  text: 'Reroute acceptance checklist',
  provenance: { slot: 'ocr', endpoint: 'ocr.local' },
  schemaVersion: 1,
  createdAt: '2026-07-14T12:00:05.000Z',
  capturedAt: '2026-07-14T12:00:04.000Z',
})

const provisionalField = (): FieldValue => ({
  id: SOURCE_FIELD_KEY,
  fieldId: FIELD_ID,
  workspaceId: FROM,
  sessionId: SESSION_ID,
  label: 'Topic',
  value: 'rerouting',
  state: 'provisional',
  spanId: 'span-field',
  provenance: {
    templateId: 'tpl-topic',
    slot: 'llm',
    endpoint: 'llm.fast',
    model: 'tiny-local',
    sourceChunks: ['chunk-1'],
  },
  updatedAt: '2026-07-14T12:00:17.000Z',
  schemaVersion: 1,
})

const annotation = (nature: string, direction: string, updatedAt: string): SessionAnnotation => ({
  id: SOURCE_ANNOTATION_KEY,
  workspaceId: FROM,
  sessionId: SESSION_ID,
  nature,
  direction,
  topics: ['session rerouting'],
  provenance: {
    templateId: 'tpl-orientation',
    endpoint: 'llm.judge',
    model: 'judge-local',
    windowStart: '2026-07-14T12:00:00.000Z',
    windowEnd: '2026-07-14T12:00:15.000Z',
    classifiedAt: updatedAt,
  },
  updatedAt,
  schemaVersion: 1,
})

const hold = (id: string, workspaceId: string, sessionId: string, sourceChunks: string[]): GuardHold => ({
  id,
  workspaceId,
  sessionId,
  stage: 'distill',
  spanId: `span-${id}`,
  sourceChunks,
  verdict: {
    behavior: 'hold-and-surface',
    outcome: 'held',
    guarded: true,
    maskedSpanCount: 1,
    spans: [{ kind: 'secret', start: 0, length: 6 }],
    guardEndpoint: 'guard.local',
    reason: `${id} was held`,
  },
  status: 'held',
  createdAt: id === 'hold-moved' ? '2026-07-14T12:00:20.000Z' : '2026-07-14T11:00:00.000Z',
})

interface SeededHistory {
  fields: VersionedDocument<FieldValue>[]
  annotations: VersionedDocument<SessionAnnotation>[]
  todoItems: TodoList['items']
}

const versionsFor = <T>(reg: WorkspaceRegistry, kind: string, key: string) =>
  reg.layouts.versionsOfKind<T>(kind).filter((doc) => doc.key === key)

const seed = (reg: WorkspaceRegistry): SeededHistory => {
  reg.ensureWorkspace({ id: TO, name: 'Destination' })
  reg.saveSession(session())
  reg.saveSttSegment(segment())
  reg.saveDistillate(distillate())
  reg.saveMoment(moment())
  reg.saveOcrResult(ocr())

  const fields = new FieldValueStore(reg)
  const first = provisionalField()
  fields.put(first)
  fields.put({
    ...first,
    state: 'confirmed',
    provenance: {
      ...first.provenance,
      judge: {
        templateId: 'tpl-judge',
        endpoint: 'llm.judge',
        model: 'judge-local',
        verdict: 'confirm',
        judgedAt: '2026-07-14T12:01:00.000Z',
        spanId: 'span-judge',
      },
    },
    updatedAt: '2026-07-14T12:01:00.000Z',
  })

  reg.layouts.put(ANNOTATION_KIND, SOURCE_ANNOTATION_KEY, annotation('unclear', 'unclear', '2026-07-14T12:00:30.000Z'))
  reg.layouts.put(ANNOTATION_KIND, SOURCE_ANNOTATION_KEY, annotation('meeting', 'mixed', '2026-07-14T12:01:30.000Z'))

  const holds = new GuardHoldStore(reg)
  holds.add(hold('hold-moved', FROM, SESSION_ID, ['chunk-1']))
  holds.add(hold('hold-source-other', FROM, 'ses-source-other', ['chunk-source-other']))
  holds.add(hold('hold-dest-other', TO, 'ses-dest-other', ['chunk-dest-other']))

  const todos = new TodoDocuments(reg)
  const firstTodo = todos.save({
    id: SESSION_ID,
    name: 'reroute follow-ups',
    version: 1,
    sessionId: SESSION_ID,
    workspaceId: FROM,
    items: [
      {
        id: 'todo-1',
        text: 'Verify the trace after rerouting',
        provenance: { sessionId: SESSION_ID, distillateId: 'distillate-1' },
        createdAt: '2026-07-14T12:02:00.000Z',
      },
    ],
  })
  const currentTodo = todos.save({
    ...firstTodo,
    items: [
      ...firstTodo.items,
      {
        id: 'todo-2',
        text: 'Merge when green',
        provenance: { sessionId: SESSION_ID, momentId: 'moment-1' },
        createdAt: '2026-07-14T12:03:00.000Z',
      },
    ],
  })

  return {
    fields: versionsFor<FieldValue>(reg, FIELD_KIND, SOURCE_FIELD_KEY),
    annotations: versionsFor<SessionAnnotation>(reg, ANNOTATION_KIND, SOURCE_ANNOTATION_KEY),
    todoItems: currentTodo.items,
  }
}

const destinationLayoutSnapshot = (reg: WorkspaceRegistry) => ({
  fields: versionsFor<FieldValue>(reg, FIELD_KIND, DEST_FIELD_KEY),
  annotations: versionsFor<SessionAnnotation>(reg, ANNOTATION_KIND, DEST_ANNOTATION_KEY),
  holds: new GuardHoldStore(reg).list(TO),
  todos: versionsFor<TodoList>(reg, TODO_KIND, SESSION_ID),
})

test('moveSession preserves the complete trace graph and removes source-visible session state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-reroute-evidence-'))
  const reg = new WorkspaceRegistry(dir)
  try {
    const seeded = seed(reg)

    reg.moveSession(SESSION_ID, FROM, TO)

    const movedFields = versionsFor<FieldValue>(reg, FIELD_KIND, DEST_FIELD_KEY)
    assert.deepEqual(
      movedFields,
      seeded.fields.map((doc) => ({ ...doc, key: DEST_FIELD_KEY, body: { ...doc.body, id: DEST_FIELD_KEY, workspaceId: TO } })),
      'every field revision keeps its exact version and creation time under the destination key',
    )
    assert.equal(reg.layouts.getLatest(FIELD_KIND, SOURCE_FIELD_KEY), undefined)

    const movedAnnotations = versionsFor<SessionAnnotation>(reg, ANNOTATION_KIND, DEST_ANNOTATION_KEY)
    assert.deepEqual(
      movedAnnotations,
      seeded.annotations.map((doc) => ({ ...doc, key: DEST_ANNOTATION_KEY, body: { ...doc.body, id: DEST_ANNOTATION_KEY, workspaceId: TO } })),
      'orientation corrections remain an intact destination history',
    )
    assert.equal(reg.layouts.getLatest(ANNOTATION_KIND, SOURCE_ANNOTATION_KEY), undefined)

    const holds = new GuardHoldStore(reg)
    assert.deepEqual(new Set(holds.list(TO).map((item) => item.id)), new Set(['hold-moved', 'hold-dest-other']))
    assert.equal(holds.list(TO).find((item) => item.id === 'hold-moved')?.workspaceId, TO)
    assert.deepEqual(holds.list(FROM).map((item) => item.id), ['hold-source-other'], 'unrelated source holds survive')

    const todo = new TodoDocuments(reg).get(SESSION_ID)
    assert.equal(todo?.workspaceId, TO)
    assert.equal(todo?.version, 3, 'the ownership change is a new editable document revision')
    assert.deepEqual(todo?.items, seeded.todoItems)
    assert.deepEqual(reg.listTodos(FROM, SESSION_ID), [], 'the current projection is absent from the source')
    assert.deepEqual(reg.listTodos(TO, SESSION_ID).map((list) => list.id), [SESSION_ID])

    assert.deepEqual(reg.listSttSegments(FROM, SESSION_ID), [])
    assert.deepEqual(reg.listOcrResults(FROM, SESSION_ID), [])
    assert.equal(reg.listSttSegments(TO, SESSION_ID)[0]?.workspaceId, TO)
    assert.equal(reg.listOcrResults(TO, SESSION_ID)[0]?.workspaceId, TO)

    const trail = buildTrace('seg-1', {
      sttSegments: reg.listSttSegments(TO, SESSION_ID),
      distillates: reg.listDistillates(TO, SESSION_ID),
      moments: reg.listMoments(TO, SESSION_ID),
      // Trace owns same-pass collapse; feed the raw durable revisions so an earlier input's pass survives.
      fieldValues: new FieldValueStore(reg).history(TO, SESSION_ID),
      guardHolds: holds.list(TO),
      ocrResults: reg.listOcrResults(TO, SESSION_ID),
    })
    assert.ok(trail, 'the moved STT root remains discoverable')
    const stages = trail.hops.map((hop) => hop.stage)
    assert.deepEqual(stages.slice(0, 2), ['summary', 'moment'])
    assert.deepEqual(stages.filter((stage) => stage === 'field' || stage === 'judge'), ['field', 'judge'])
    assert.equal(stages.filter((stage) => stage === 'held').length, 1, 'the held branch remains in the graph')

    assert.equal(reg.getSession(FROM, SESSION_ID), undefined)
    assert.deepEqual(reg.sessionWorkspaces(SESSION_ID), [TO])
  } finally {
    reg.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('moveSession layout copy is idempotent across an interrupted reroute and completed re-runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-reroute-evidence-retry-'))
  const reg = new WorkspaceRegistry(dir)
  try {
    seed(reg)
    // Structurally corrupt but unrelated documents used to be parsed by versionsOfKind() during every
    // move. Exact source-key reads keep these isolated from a healthy session's reroute.
    reg.layouts.put(FIELD_KIND, 'fv:unrelated:ses-other:field-bad', null)
    reg.layouts.put(ANNOTATION_KIND, 'oa:unrelated:ses-other', null)

    reg.moveSession(SESSION_ID, FROM, TO, { stopAfterCopy: true })
    assert.deepEqual(reg.sessionWorkspaces(SESSION_ID).sort(), [FROM, TO])
    assert.equal(versionsFor<FieldValue>(reg, FIELD_KIND, SOURCE_FIELD_KEY).length, 2, 'source history is intact before phase 2')
    assert.equal(versionsFor<SessionAnnotation>(reg, ANNOTATION_KIND, SOURCE_ANNOTATION_KEY).length, 2)
    assert.equal(new GuardHoldStore(reg).list(FROM).filter((item) => item.id === 'hold-moved').length, 1)
    assert.equal(new GuardHoldStore(reg).list(TO).filter((item) => item.id === 'hold-moved').length, 1)
    assert.equal(new TodoDocuments(reg).get(SESSION_ID)?.workspaceId, TO, 'the globally-keyed todo has one current owner')

    new GuardHoldStore(reg).resolve(TO, 'hold-moved', 'released', '2026-07-14T12:05:00.000Z')
    const copied = destinationLayoutSnapshot(reg)
    reg.moveSession(SESSION_ID, FROM, TO)
    assert.deepEqual(destinationLayoutSnapshot(reg), copied, 'finishing phase 2 adds no duplicate destination versions')
    assert.equal(new GuardHoldStore(reg).list(TO).find((item) => item.id === 'hold-moved')?.status, 'released')
    assert.equal(reg.layouts.getLatest(FIELD_KIND, SOURCE_FIELD_KEY), undefined)
    assert.equal(reg.layouts.getLatest(ANNOTATION_KIND, SOURCE_ANNOTATION_KEY), undefined)
    assert.equal(new GuardHoldStore(reg).list(FROM).some((item) => item.id === 'hold-moved'), false)
    assert.deepEqual(reg.listTodos(FROM, SESSION_ID), [])

    reg.moveSession(SESSION_ID, FROM, TO)
    assert.deepEqual(destinationLayoutSnapshot(reg), copied, 'an already-completed reroute remains a no-op')
    assert.equal(versionsFor<TodoList>(reg, TODO_KIND, SESSION_ID).length, 3, 'todo ownership is versioned once')
    assert.deepEqual(reg.sessionWorkspaces(SESSION_ID), [TO])
  } finally {
    reg.close()
    await rm(dir, { recursive: true, force: true })
  }
})
