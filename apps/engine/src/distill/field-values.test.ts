import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import type { FieldValue } from '@openinfo/contracts'
import { WorkspaceRegistry } from '../store/index.js'
import { FieldValueStore, groupFieldValuePasses } from './field-values.js'

const value = (over: Partial<FieldValue> = {}): FieldValue => ({
  id: FieldValueStore.idFor('default', 'field-topic', 'ses-1'),
  fieldId: 'field-topic',
  workspaceId: 'default',
  sessionId: 'ses-1',
  label: 'Topic',
  value: 'launch planning',
  state: 'provisional',
  spanId: 'field-pass-1',
  provenance: {
    templateId: 'tpl-topic',
    slot: 'llm',
    endpoint: 'llm.fast',
    sourceChunks: ['cap-1'],
  },
  updatedAt: '2026-07-14T14:00:01.000Z',
  schemaVersion: 1,
  ...over,
})

test('history keeps every field pass after the latest projection advances the deterministic id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-field-history-'))
  const registry = new WorkspaceRegistry(dir)
  try {
    const values = new FieldValueStore(registry)
    const first = value()
    const judged: FieldValue = {
      ...first,
      state: 'confirmed',
      provenance: {
        ...first.provenance,
        judge: {
          templateId: 'tpl-judge-default',
          endpoint: 'llm.judge',
          verdict: 'confirm',
          judgedAt: '2026-07-14T14:00:02.000Z',
          spanId: 'judge-pass-1',
        },
      },
      updatedAt: '2026-07-14T14:00:02.000Z',
    }
    const later = value({
      value: 'pricing review',
      spanId: 'field-pass-2',
      provenance: { ...first.provenance, sourceChunks: ['cap-2'] },
      updatedAt: '2026-07-14T14:05:01.000Z',
    })

    values.put(first)
    values.put(judged)
    values.put(later)

    assert.deepEqual(values.list('default', 'ses-1').map((row) => row.value), ['pricing review'], 'product reads remain latest-only')
    assert.deepEqual(
      values.history('default', 'ses-1').map((row) => [row.spanId, row.state, row.value]),
      [
        ['field-pass-1', 'provisional', 'launch planning'],
        ['field-pass-1', 'confirmed', 'launch planning'],
        ['field-pass-2', 'provisional', 'pricing review'],
      ],
      'audit reads retain the provisional→judge revision and the distinct later fast pass',
    )
    assert.deepEqual(
      values.passes('default', 'ses-1').map((row) => [row.spanId, row.state, row.value]),
      [
        ['field-pass-1', 'confirmed', 'launch planning'],
        ['field-pass-2', 'provisional', 'pricing review'],
      ],
      'the audit projection collapses only the same-pass judge revision',
    )
  } finally {
    registry.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('same-pass collapse and review history trust append order when the wall clock moves backward', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-field-append-order-'))
  const registry = new WorkspaceRegistry(dir)
  try {
    const values = new FieldValueStore(registry)
    const producer = value({ value: 'first answer', updatedAt: '2026-07-14T14:00:10.000Z' })
    const firstReview = value({
      ...producer,
      value: 'first correction',
      state: 'corrected',
      provenance: {
        ...producer.provenance,
        judge: {
          templateId: 'tpl-judge-default', endpoint: 'llm.judge', verdict: 'correct', priorValue: producer.value,
          note: 'first review', judgedAt: '2026-07-14T14:00:11.000Z', spanId: 'same-review-span',
        },
      },
      updatedAt: '2026-07-14T14:00:11.000Z',
    })
    const secondReview = value({
      ...firstReview,
      value: 'second correction',
      provenance: {
        ...firstReview.provenance,
        judge: {
          ...firstReview.provenance.judge!,
          priorValue: firstReview.value,
          note: 'second persisted review with colliding identity fields',
        },
      },
      // The persisted document version is later, but NTP/system-clock correction moved wall time back.
      updatedAt: '2026-07-14T13:59:59.000Z',
    })

    values.put(producer)
    values.put(firstReview)
    values.put(secondReview)

    assert.equal(values.passes('default', 'ses-1')[0]!.value, 'second correction', 'last append wins the causal pass')
    const grouped = groupFieldValuePasses(values.history('default', 'ses-1'))
    assert.equal(grouped[0]!.producer.value, 'first answer')
    assert.deepEqual(
      grouped[0]!.reviews.map((revision) => [revision.value, revision.provenance.judge?.note]),
      [
        ['first correction', 'first review'],
        ['second correction', 'second persisted review with colliding identity fields'],
      ],
      'without a persisted retry id, every judge-stamped append remains an ordered review revision',
    )
  } finally {
    registry.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('legacy identical source windows retain producer→judge generation boundaries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-field-legacy-generations-'))
  const registry = new WorkspaceRegistry(dir)
  try {
    const values = new FieldValueStore(registry)
    const legacyProducer = (text: string, at: string): FieldValue => {
      const row = value({ value: text, updatedAt: at, provenance: { ...value().provenance, windowStart: '2026-07-14T14:00:00.000Z', windowEnd: '2026-07-14T14:00:15.000Z' } })
      delete row.spanId
      return row
    }
    const reviewed = (producer: FieldValue, text: string, at: string): FieldValue => ({
      ...producer,
      value: text,
      state: 'corrected',
      provenance: {
        ...producer.provenance,
        judge: { templateId: 'tpl-judge-default', endpoint: 'llm.judge', verdict: 'correct', priorValue: producer.value, judgedAt: at },
      },
      updatedAt: at,
    })
    const first = legacyProducer('legacy first', '2026-07-14T14:00:01.000Z')
    const firstJudged = reviewed(first, 'legacy first fixed', '2026-07-14T14:00:02.000Z')
    const second = legacyProducer('legacy second', '2026-07-14T14:05:01.000Z')
    const secondJudged = reviewed(second, 'legacy second fixed', '2026-07-14T14:05:02.000Z')
    for (const row of [first, firstJudged, second, secondJudged]) values.put(row)

    assert.deepEqual(
      values.passes('default', 'ses-1').map((row) => row.value),
      ['legacy first fixed', 'legacy second fixed'],
      'each new spanless producer starts a generation and its following judge attaches to it',
    )
    assert.equal(
      groupFieldValuePasses(values.history('default', 'ses-1', 3)).length,
      2,
      'when the bounded window starts on a judge row, the next producer still starts another generation',
    )
  } finally {
    registry.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('history filters exact JSON workspace/session scope and caps in SQL before parsing bodies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-field-scoped-history-'))
  const registry = new WorkspaceRegistry(dir)
  try {
    const values = new FieldValueStore(registry)
    const forScope = (workspaceId: string, sessionId: string, text: string, at: string): FieldValue =>
      value({
        id: FieldValueStore.idFor(workspaceId, 'field-topic', sessionId), workspaceId, sessionId, value: text,
        spanId: `span-${text}`, updatedAt: at,
      })
    values.put(forScope('a', 'ses-1', 'workspace a', '2026-07-14T14:00:01.000Z'))
    values.put(forScope('a:b', 'ses-1', 'workspace a:b first', '2026-07-14T14:00:02.000Z'))
    values.put(forScope('a:b', 'ses-1', 'workspace a:b second', '2026-07-14T14:00:03.000Z'))
    values.put(forScope('a:b', 'ses-2', 'other session', '2026-07-14T14:00:04.000Z'))

    // This key would alias the old `fv:a:` prefix query, and its body is deliberately unparsable. The
    // guarded exact JSON predicate must reject it before JSON.parse and before it consumes the row limit.
    const db = new Database(join(dir, '_meta.db'))
    db.prepare('insert into documents (kind, key, version, body, created_at) values (?, ?, ?, ?, ?)').run(
      'field-value', 'fv:a:colon-shaped-corrupt', 1, '{not json', '2026-07-14T14:00:05.000Z',
    )
    db.close()

    assert.deepEqual(values.history('a').map((row) => row.value), ['workspace a'])
    assert.deepEqual(
      values.history('a:b', 'ses-1', 1).map((row) => row.value),
      ['workspace a:b second'],
      'the SQL limit selects the latest append inside the exact workspace/session scope',
    )
    assert.deepEqual(
      values.history('a:b', 'ses-1', 2).map((row) => row.value),
      ['workspace a:b first', 'workspace a:b second'],
      'limited rows return in global append order',
    )
  } finally {
    registry.close()
    await rm(dir, { recursive: true, force: true })
  }
})
