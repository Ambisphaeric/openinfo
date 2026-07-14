import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FieldValue } from '@openinfo/contracts'
import { WorkspaceRegistry } from '../store/index.js'
import { FieldValueStore } from './field-values.js'

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
