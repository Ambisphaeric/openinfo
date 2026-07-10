import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Dials } from '@openinfo/contracts'
import type { LlmResult } from '../fabric/index.js'
import { defaultEntitiesTemplate } from '../distill/defaults.js'
import { entityMentioned, extractEntities, normalizeName, type ExtractEntitiesInput } from './extract.js'

const dials: Dials = { tone: 3, warmth: 4, wit: 2, charm: 2, specificity: 9, brevity: 8 }

const input: ExtractEntitiesInput = {
  transcript: 'Dana asked about the SOC 2 addendum. I will route the retention language through legal.',
  summary: 'Dana asked about SOC 2; user routes retention language through legal.',
  windowStart: '2026-07-07T14:43:30Z',
  windowEnd: '2026-07-07T14:45:00Z',
  dials,
}

const canned = (...responses: string[]) => {
  const prompts: string[] = []
  let call = 0
  const invoke = async (messages: { content: string }[]): Promise<LlmResult> => {
    prompts.push(messages[0]!.content)
    const text = responses[Math.min(call, responses.length - 1)]!
    call += 1
    return { text, endpoint: 'llm.fast', model: 'llama-3.2-3b', slot: 'llm' }
  }
  return { invoke, prompts, calls: () => call }
}

test('well-formed llm output extracts typed entity candidates', async () => {
  const llm = canned(
    JSON.stringify([
      { kind: 'person', name: 'Dana', aliases: ['Dana Cruz'] },
      { kind: 'artifact', name: 'SOC 2 addendum' },
      { kind: 'topic', name: 'retention language' },
    ]),
  )
  const result = await extractEntities(input, { invoke: llm.invoke, template: defaultEntitiesTemplate })

  assert.equal(result.entities.length, 3)
  assert.equal(result.dropped, 0)
  assert.equal(result.attempts, 1)
  const dana = result.entities.find((e) => e.kind === 'person')!
  assert.equal(dana.name, 'Dana')
  assert.deepEqual(dana.aliases, ['Dana Cruz'])
  const artifact = result.entities.find((e) => e.kind === 'artifact')!
  assert.deepEqual(artifact.aliases, [])

  // #130: the neutral default entities template interpolates the WINDOW inputs but bakes NO voice vector.
  assert.doesNotMatch(llm.prompts[0]!, /specificity|brevity|\bVoice:\s/i)
  assert.match(llm.prompts[0]!, /SOC 2 addendum/) // {{transcript}}
  assert.match(llm.prompts[0]!, /user routes retention language/) // {{summary}}
})

test('partially-valid output: valid candidates kept, invalid dropped (not retried)', async () => {
  const llm = canned(
    '```json\n[\n' +
      '{"kind": "company", "name": "not a real kind"},\n' +
      '{"kind": "person"},\n' +
      '{"kind": "person", "name": "   "},\n' +
      '{"kind": "topic", "name": "retention language", "aliases": ["Retention Language", 42, " retention  language "]}\n' +
      ']\n```',
  )
  const result = await extractEntities(input, { invoke: llm.invoke, template: defaultEntitiesTemplate })
  assert.equal(result.entities.length, 1)
  assert.equal(result.dropped, 3)
  assert.equal(llm.calls(), 1)
  // aliases: non-strings dropped, duplicates-of-name (after normalization) dropped
  assert.deepEqual(result.entities[0]!.aliases, [])
})

test('zero-entity window is a normal outcome, not an error', async () => {
  const llm = canned('[]')
  const result = await extractEntities(input, { invoke: llm.invoke, template: defaultEntitiesTemplate })
  assert.deepEqual(result.entities, [])
  assert.equal(result.dropped, 0)
  assert.equal(result.attempts, 1) // a clean [] is parsed — no re-sample
})

test('wholly unparseable output re-samples once (bounded), then yields zero entities', async () => {
  const llm = canned('I would rather not.', '[{"kind": "person", "name": "Dana"}]')
  const result = await extractEntities(input, { invoke: llm.invoke, template: defaultEntitiesTemplate })
  assert.equal(result.attempts, 2)
  assert.equal(result.entities.length, 1)

  const hopeless = canned('nope', 'still nope', 'never')
  const empty = await extractEntities(input, { invoke: hopeless.invoke, template: defaultEntitiesTemplate, maxAttempts: 2 })
  assert.equal(empty.attempts, 2)
  assert.equal(hopeless.calls(), 2) // bounded — never a third call
  assert.deepEqual(empty.entities, [])
})

test('transport failure propagates (drain re-queue owns retry-at-idle)', async () => {
  const invoke = async (): Promise<LlmResult> => {
    throw new Error('no llm endpoint answered')
  }
  await assert.rejects(
    () => extractEntities(input, { invoke, template: defaultEntitiesTemplate }),
    /no llm endpoint answered/,
  )
})

test('wrapped {entities: []} responses parse like bare arrays', async () => {
  const llm = canned('{"entities": [{"kind": "topic", "name": "SOC 2"}]}')
  const result = await extractEntities(input, { invoke: llm.invoke, template: defaultEntitiesTemplate })
  assert.equal(result.entities.length, 1)
  assert.equal(result.entities[0]!.name, 'SOC 2')
})

test('normalizeName collapses case and whitespace', () => {
  assert.equal(normalizeName('  Dana   Cruz '), 'dana cruz')
  assert.equal(normalizeName('SOC 2'), 'soc 2')
})

test('entityMentioned matches names and aliases at word boundaries, case-insensitive', () => {
  assert.ok(entityMentioned('written answer to Dana by Thursday?', 'Dana'))
  assert.ok(entityMentioned('ping dana cruz today', 'Dana', ['Dana Cruz']))
  assert.ok(entityMentioned('the SOC 2 addendum (v2)', 'SOC 2 addendum'))
  assert.ok(!entityMentioned('Danaher earnings call', 'Dana')) // word boundary — no substring hits
  assert.ok(!entityMentioned('nothing relevant here', 'Dana', ['Dana Cruz']))
  assert.ok(!entityMentioned('regex specials are safe', 'a+b (c)')) // escaped, no throw
})
