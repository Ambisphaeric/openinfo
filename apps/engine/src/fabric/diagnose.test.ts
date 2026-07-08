import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AggregateInvokeError, InvokeError } from './invoke-error.js'
import { toQueueFailure } from './diagnose.js'

const at = '2026-07-07T14:05:00Z'

test('toQueueFailure: classifies an aggregate throw into the QueueFailure shape (keyRef, no value)', async () => {
  const inner = new InvokeError('auth', { endpoint: 'remote', url: 'http://h', keyRef: 'k' })
  const agg = new AggregateInvokeError('llm', 'no llm endpoint answered', [inner.toFailure()])
  const failure = await toQueueFailure(agg, at, async (f) => f.hint)
  assert.equal(failure?.class, 'auth')
  assert.equal(failure?.endpoint, 'remote')
  assert.equal(failure?.keyRef, 'k')
  assert.equal(failure?.at, at)
})

test('toQueueFailure: a NON-invoke error is left unclassified (undefined — never faked into a class)', async () => {
  assert.equal(await toQueueFailure(new Error('disk full'), at), undefined)
})

test('toQueueFailure: a model-load failure gets its hint enriched with the loaded-model suggestion', async () => {
  const inner = new InvokeError('model-load', { endpoint: 'lm', url: 'http://h', model: 'big' })
  const agg = new AggregateInvokeError('llm', 'no llm endpoint answered', [inner.toFailure()])
  const failure = await toQueueFailure(agg, at, async () => 'base hint. server reports 1 other model (e.g. small) — switch in Settings → Endpoints')
  assert.match(failure?.hint ?? '', /server reports 1 other model/)
})
