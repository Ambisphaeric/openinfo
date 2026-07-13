import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  FixtureError,
  canonicalJson,
  canonicalStringify,
  computeFixtureDigest,
  createFixtureReplay,
  fixtureIdForDigest,
  loadFixtureSync,
  parseFixture,
  recordFixture,
  replayFixture,
  validateFixture,
} from './model.mjs'
import { FixtureEnvelopeSchema } from './schema.mjs'

const fixturePath = new URL('./fixtures/synthetic-converged.v1.json', import.meta.url)
const inputPath = new URL('./examples/synthetic-converged.jsonl', import.meta.url)
const loadInput = () => readFileSync(inputPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
const resign = (fixture) => {
  fixture.digest = computeFixtureDigest(fixture)
  fixture.fixtureId = fixtureIdForDigest(fixture.digest)
  return fixture
}

test('committed synthetic fixture validates and keeps mic/system-audio/screen lanes separate', () => {
  const fixture = loadFixtureSync(fixturePath)
  assert.equal(fixture.formatVersion, 1)
  assert.deepEqual(fixture.entries.map(({ ordinal }) => ordinal), [0, 1, 2, 3, 4, 5, 6, 7])
  assert.deepEqual(fixture.entries.filter(({ kind }) => kind === 'stt').map(({ lane }) => lane), ['mic', 'system-audio'])
  assert.deepEqual(fixture.entries.filter(({ kind }) => kind === 'ocr' || kind === 'vlm').map(({ lane }) => lane), ['screen', 'screen'])
  assert.equal(fixture.privacy.classification, 'synthetic')
  assert.equal(fixture.privacy.rawMedia, true)
})

test('recording the same normalized input twice produces byte-identical canonical output', () => {
  const options = { classification: 'synthetic', allowRawMedia: true, replayAt: '2026-07-12T13:00:03.000Z' }
  const first = recordFixture(loadInput(), options)
  const second = recordFixture(loadInput(), options)
  assert.equal(canonicalStringify(first), canonicalStringify(second))
  assert.equal(canonicalStringify(first), readFileSync(fixturePath, 'utf8'))
  assert.equal(canonicalJson({ z: 1, a: { y: 2, b: 3 } }), '{"a":{"b":3,"y":2},"z":1}')
  assert.equal(canonicalStringify(first).endsWith('\n'), true)
  assert.equal(canonicalJson(first).endsWith('\n'), false, 'digest serialization has no file newline')
})

test('schema artifact stays canonical and synchronized with the runtime schema', () => {
  const schemaPath = new URL('./fixture.schema.json', import.meta.url)
  assert.equal(readFileSync(schemaPath, 'utf8'), canonicalStringify(FixtureEnvelopeSchema))
})

test('reader rejects unsupported versions before replay but tolerates same-version additive fields', () => {
  const fixture = loadFixtureSync(fixturePath)
  assert.throws(() => validateFixture({ ...fixture, formatVersion: 2 }), /unsupported formatVersion 2/)
  const additive = structuredClone(fixture)
  additive.futureEnvelopeField = { safe: true }
  additive.entries[0].futureEntryField = 'ignored-by-v1'
  assert.doesNotThrow(() => validateFixture(resign(additive)))
})

test('integrity, ordering, identity, timestamps, references, lanes, slots, and privacy fail closed', () => {
  const fixture = loadFixtureSync(fixturePath)
  const cases = [
    ['digest', (f) => { f.digest = `sha256:${'0'.repeat(64)}` }, /integrity mismatch/],
    ['ordinal', (f) => { f.entries[1].ordinal = 9 }, /expected contiguous ordinal 1/],
    ['entry id', (f) => { f.entries[1].id = f.entries[0].id }, /duplicate entry id/],
    ['time', (f) => { f.entries[0].at = 'not-a-time' }, /canonical UTC ISO timestamp/],
    ['reference', (f) => { f.entries[1].inputIds = ['missing'] }, /missing or not earlier/],
    ['lane', (f) => { f.entries[1].lane = 'system-audio' }, /disagrees with input capture/],
    ['slot', (f) => { f.entries[1].output.slot = 'ocr' }, /Expected union value|disagrees with stage kind/],
    ['raw media', (f) => { f.privacy.rawMedia = false }, /must equal presence/],
    ['redaction', (f) => { f.entries[0].media = 'redacted' }, /redacted media must contain no original bytes/],
    ['media encoding', (f) => { f.entries[0].value.encoding = 'utf8'; f.entries[0].media = 'text'; f.privacy.rawMedia = true }, /audio\/image captures must use base64/],
    ['base64', (f) => { f.entries[0].value.data = 'not base64!' }, /invalid or non-canonical base64 payload/],
  ]
  for (const [name, mutate, pattern] of cases) {
    const changed = structuredClone(fixture)
    mutate(changed)
    if (name !== 'digest') resign(changed)
    let observed = 0
    assert.throws(() => replayFixture(changed, () => observed++), pattern, name)
    assert.equal(observed, 0, `${name}: callback fired before full validation`)
  }
  assert.throws(() => parseFixture('{', 'broken.json'), /broken\.json: invalid JSON/)
})

test('record refuses implicit media, raw data without sensitive classification, and duplicate explicit ordinals', () => {
  const input = loadInput()
  delete input[0].media
  assert.throws(() => recordFixture(input, { classification: 'synthetic', allowRawMedia: true }), /classify inline audio\/image/)
  const raw = loadInput()
  raw[0].media = 'raw'
  assert.throws(() => recordFixture(raw, { classification: 'synthetic', allowRawMedia: true }), /requires --privacy sensitive/)
  const duplicated = loadInput().slice(0, 2).map((entry) => ({ ...entry, ordinal: 0 }))
  assert.throws(() => recordFixture(duplicated, { classification: 'synthetic', allowRawMedia: true }), /duplicate ordinal/)
  assert.throws(() => recordFixture(loadInput(), { classification: 'synthetic' }), /explicit allowRawMedia=true/)
})

test('v1 rejects batch stage inputs instead of replaying one output more than once', () => {
  const fixture = loadFixtureSync(fixturePath)
  const changed = structuredClone(fixture)
  changed.entries[1].inputIds.push('cap-system-0001')
  resign(changed)
  assert.throws(() => validateFixture(changed), /Expected union value/)
})

test('pure replay returns recorded model-boundary outputs and stable clocks/ids without network access', async () => {
  const fixture = loadFixtureSync(fixturePath)
  const replay = createFixtureReplay(fixture)
  const screen = replay.captures('screen').find(({ contentType }) => contentType === 'image/jpeg')
  assert.ok(screen)
  const originalFetch = globalThis.fetch
  let networkCalls = 0
  globalThis.fetch = async () => {
    networkCalls++
    throw new Error('fixture replay attempted network access')
  }
  try {
    const ocr = await replay.invokeOcrFor(screen.id, { image: screen.data, contentType: screen.contentType })
    assert.equal(ocr.text, 'Pull request 150 — checks passing')
    assert.equal(ocr.endpoint, 'fixture-ocr')
    const first = [replay.now().toISOString(), replay.newId(), replay.newId()]
    replay.reset()
    const second = [replay.now().toISOString(), replay.newId(), replay.newId()]
    assert.deepEqual(second, first)
    assert.equal(networkCalls, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('v1 rejects two outputs from the same stage for one capture', () => {
  const fixture = loadFixtureSync(fixturePath)
  const changed = structuredClone(fixture)
  const duplicate = structuredClone(changed.entries[1])
  duplicate.ordinal = 2
  duplicate.id = 'duplicate-stt-output'
  changed.entries.splice(2, 0, duplicate)
  for (let index = 0; index < changed.entries.length; index++) changed.entries[index].ordinal = index
  resign(changed)
  assert.throws(() => validateFixture(changed), /duplicate stt output for capture cap-mic-0001/)
})

test('capture-scoped replay cannot cross lanes when identical payload bytes have different outputs', async () => {
  const entries = loadInput().slice(0, 4)
  entries[2].value.data = entries[0].value.data
  entries[2].value.contentType = entries[0].value.contentType
  const fixture = recordFixture(entries, {
    classification: 'synthetic',
    allowRawMedia: true,
    replayAt: '2026-07-12T13:00:02.000Z',
  })
  const replay = createFixtureReplay(fixture)
  await assert.rejects(() => replay.invokeStt({ base64: entries[0].value.data, contentType: 'audio/wav' }), /ambiguous.*capture-scoped/)
  const mic = await replay.invokeSttFor('cap-mic-0001', { base64: entries[0].value.data, contentType: 'audio/wav' })
  const system = await replay.invokeSttFor('cap-system-0001', { base64: entries[0].value.data, contentType: 'audio/wav' })
  assert.equal(mic.text, 'Please follow up on the synthetic build.')
  assert.equal(system.text, 'I will review the synthetic change.')
})

test('fixture errors remain actionable errors', () => {
  assert.ok(new FixtureError('x') instanceof Error)
})
