import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Value } from '@sinclair/typebox/value'
import { Moment as MomentSchema, type Dials } from '@openinfo/contracts'
import type { LlmResult } from '../fabric/index.js'
import { defaultExtractTemplate } from './defaults.js'
import { extractMoments, parseMomentCandidates, type ExtractInput } from './moments.js'

const dials: Dials = { tone: 3, warmth: 4, wit: 2, charm: 2, specificity: 9, brevity: 8 }

const input: ExtractInput = {
  transcript: 'I will send the retention language to legal today.\nCan you get Dana a written answer by Thursday?',
  summary: 'User committed to routing retention language through legal today.',
  sessionId: 'ses-x',
  workspaceId: 'ws-x',
  windowStart: '2026-07-07T14:43:30Z',
  windowEnd: '2026-07-07T14:45:00Z',
  source: 'mic',
  dials,
  distillateId: 'dst-x',
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

test('well-formed llm output extracts typed, contract-valid moments with provenance', async () => {
  const llm = canned(
    JSON.stringify([
      { kind: 'commitment', text: 'send retention language to legal today', speaker: 'user', confidence: 0.9 },
      { kind: 'question', text: 'written answer to Dana by Thursday?', answered: false },
    ]),
  )
  const result = await extractMoments(input, { invoke: llm.invoke, template: defaultExtractTemplate })

  assert.equal(result.moments.length, 2)
  assert.equal(result.dropped, 0)
  assert.equal(result.attempts, 1)
  for (const moment of result.moments) {
    assert.deepEqual([...Value.Errors(MomentSchema, moment)], [])
    assert.equal(moment.sessionId, 'ses-x')
    assert.equal(moment.workspaceId, 'ws-x')
    assert.equal(moment.provenance?.distillateId, 'dst-x')
    assert.equal(moment.provenance?.endpoint, 'llm.fast')
    assert.equal(moment.provenance?.model, 'llama-3.2-3b')
  }
  const [commitment, question] = result.moments
  assert.equal(commitment!.kind, 'commitment')
  assert.equal(commitment!.speaker, 'user')
  assert.equal(commitment!.confidence, 0.9)
  assert.equal(question!.kind, 'question')
  assert.equal(question!.answered, false)

  // #130: the neutral default template interpolates the WINDOW inputs but bakes NO voice vector.
  assert.match(llm.prompts[0]!, /retention language to legal/)
  assert.match(llm.prompts[0]!, /routing retention language through legal/) // {{summary}}
  assert.doesNotMatch(llm.prompts[0]!, /specificity|brevity|\bVoice:\s/i) // no baked persona dials
})

test('voice machinery still interpolates for a template that carries the dial placeholders (#130)', async () => {
  // The default body is neutral, but the machinery is untouched: an author who edits {{specificity}}/
  // {{voice.rules}} back into a template still gets the resolved dials merged into the prompt.
  const voiced = {
    ...defaultExtractTemplate,
    body: 'Voice: specificity {{specificity}}/10, brevity {{brevity}}/10. {{voice.rules}}\n\n' + defaultExtractTemplate.body,
  }
  const llm = canned('[]')
  await extractMoments(input, { invoke: llm.invoke, template: voiced })
  assert.match(llm.prompts[0]!, /specificity 9\/10/)
  assert.match(llm.prompts[0]!, /brevity 8\/10/)
})

test('partially-valid output: valid moments salvaged, invalid dropped', async () => {
  // fenced, with one bad kind, one missing text, one confidence out of range (clamped), one good
  const llm = canned(
    '```json\n[\n' +
      '{"kind": "todo", "text": "not a real kind"},\n' +
      '{"kind": "decision"},\n' +
      '{"kind": "decision", "text": "ship Thursday", "confidence": 3.5},\n' +
      '{"kind": "artifact", "text": "the SOC 2 retention addendum"}\n' +
      ']\n```',
  )
  const result = await extractMoments(input, { invoke: llm.invoke, template: defaultExtractTemplate })
  assert.equal(result.moments.length, 2)
  assert.equal(result.dropped, 2)
  const decision = result.moments.find((m) => m.kind === 'decision')!
  assert.equal(decision.confidence, 1) // clamped into contract range
  assert.ok(result.moments.some((m) => m.kind === 'artifact'))
})

test('broken array with intact objects: siblings salvaged from malformed JSON', async () => {
  const llm = canned(
    'Here are the moments:\n{"kind": "commitment", "text": "legal today"}\n{"kind": "question", "text": "Thursday?", "answered": false,,,}',
  )
  const result = await extractMoments(input, { invoke: llm.invoke, template: defaultExtractTemplate })
  assert.equal(result.moments.length, 1)
  assert.equal(result.moments[0]!.kind, 'commitment')
})

test('zero-moment window is a normal outcome, not an error', async () => {
  const llm = canned('[]')
  const result = await extractMoments(input, { invoke: llm.invoke, template: defaultExtractTemplate })
  assert.deepEqual(result.moments, [])
  assert.equal(result.dropped, 0)
  assert.equal(result.attempts, 1) // a clean [] is parsed — no re-sample
})

test('wholly unparseable output re-samples once (bounded), then yields zero moments', async () => {
  const llm = canned('Sorry, I cannot help with that.', '[{"kind": "decision", "text": "ship Thursday"}]')
  const result = await extractMoments(input, { invoke: llm.invoke, template: defaultExtractTemplate })
  assert.equal(result.attempts, 2)
  assert.equal(result.moments.length, 1)

  const hopeless = canned('nope', 'still nope', 'never')
  const empty = await extractMoments(input, { invoke: hopeless.invoke, template: defaultExtractTemplate, maxAttempts: 2 })
  assert.equal(empty.attempts, 2)
  assert.equal(hopeless.calls(), 2) // bounded — never a third call
  assert.deepEqual(empty.moments, [])
})

test('a successful retry stamps the extraction endpoint and policy result, never the preceding summary call', async () => {
  let call = 0
  const invoke = async (): Promise<LlmResult> => {
    call += 1
    if (call === 1) {
      return { text: 'not json', endpoint: 'moment-primary', model: 'small-primary', slot: 'llm' }
    }
    return {
      text: '[{"kind":"decision","text":"use the fallback"}]',
      endpoint: 'moment-fallback',
      model: 'large-fallback',
      slot: 'llm',
      usage: { estimated: false, promptTokens: 45, completionTokens: 8, totalTokens: 53, durationMs: 321 },
      egress: {
        reach: 'egress',
        allowed: true,
        decidedBy: 'default',
        reason: 'no policy layer denied this transcript hop',
        destination: 'hosted-public',
      },
      guard: {
        behavior: 'redact-and-continue',
        outcome: 'clean',
        guarded: true,
        maskedSpanCount: 0,
        guardEndpoint: 'guard-local',
        reason: 'nothing sensitive found',
      },
    }
  }

  const result = await extractMoments(input, { invoke, template: defaultExtractTemplate })
  assert.equal(result.attempts, 2)
  const provenance = result.moments[0]!.provenance!
  assert.equal(provenance.endpoint, 'moment-fallback')
  assert.equal(provenance.model, 'large-fallback')
  assert.equal(provenance.usage?.totalTokens, 53)
  assert.equal(provenance.egress?.destination, 'hosted-public')
  assert.equal(provenance.guard?.outcome, 'clean')
})

test('transport failure propagates (drain re-queue owns retry-at-idle)', async () => {
  const invoke = async (): Promise<LlmResult> => {
    throw new Error('no llm endpoint answered')
  }
  await assert.rejects(
    () => extractMoments(input, { invoke, template: defaultExtractTemplate }),
    /no llm endpoint answered/,
  )
})

test('parseMomentCandidates handles arrays, wrapped objects, and fenced JSON', () => {
  assert.deepEqual(parseMomentCandidates('[]'), { candidates: [], parsedAnything: true })
  assert.equal(parseMomentCandidates('{"moments": [{"kind":"decision","text":"x"}]}').candidates.length, 1)
  assert.equal(parseMomentCandidates('{"kind":"decision","text":"x"}').candidates.length, 1)
  assert.equal(parseMomentCandidates('```json\n[{"kind":"artifact","text":"doc"}]\n```').candidates.length, 1)
  assert.equal(parseMomentCandidates('no json here').parsedAnything, false)
  // brace inside a string literal does not confuse the balanced scan
  const tricky = parseMomentCandidates('x {"kind":"note","text":"a } inside"} y')
  assert.equal(tricky.candidates.length, 1)
})
