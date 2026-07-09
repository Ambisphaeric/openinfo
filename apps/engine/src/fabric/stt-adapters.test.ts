import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Endpoint } from '@openinfo/contracts'
import { STT_ADAPTERS, selectSttAdapter } from './stt-adapters.js'

// --- canonical normalization: every flavor maps its wire body to the ONE TranscriptResult shape ---

test('openai adapter normalizes the OpenAI/omlx verbose_json body (text + language + duration + segments)', () => {
  // This is the EXACT shape omlx 0.4.5 returned live (via its whisper model) — duration/segments in seconds.
  const body = {
    text: ' The quarterly report shipped on Thursday afternoon.',
    language: 'en',
    duration: 2.48,
    segments: [{ id: 0, start: 0.0, end: 2.48, text: ' The quarterly report shipped on Thursday afternoon.' }],
  }
  const result = STT_ADAPTERS.openai.normalize(body)
  assert.deepEqual(result, {
    text: ' The quarterly report shipped on Thursday afternoon.',
    language: 'en',
    durationSec: 2.48,
    segments: [{ text: ' The quarterly report shipped on Thursday afternoon.', startSec: 0.0, endSec: 2.48 }],
  })
})

test('omlx adapter shares the OpenAI normalizer and drops a zero duration (0.0 carries no info)', () => {
  const result = STT_ADAPTERS.omlx.normalize({ text: 'hi', language: 'en', duration: 0.0 })
  assert.deepEqual(result, { text: 'hi', language: 'en' })
})

test('openai adapter: bare {text} (plain json response_format) normalizes with no extras', () => {
  assert.deepEqual(STT_ADAPTERS.openai.normalize({ text: 'shipped Thursday' }), { text: 'shipped Thursday' })
})

test('openai adapter: empty transcript ("" silence) is a valid result, not undefined', () => {
  assert.deepEqual(STT_ADAPTERS.openai.normalize({ text: '' }), { text: '' })
})

test('openai adapter: a body with no string text ⇒ undefined (caller raises one bad-response)', () => {
  assert.equal(STT_ADAPTERS.openai.normalize({ language: 'en' }), undefined)
  assert.equal(STT_ADAPTERS.openai.normalize({ text: 42 }), undefined)
  assert.equal(STT_ADAPTERS.openai.normalize(null), undefined)
})

test('whisper-server adapter converts CENTISECOND t0/t1 segments to canonical seconds', () => {
  const body = { text: 'hello world', segments: [{ t0: 0, t1: 248, text: 'hello world' }] }
  assert.deepEqual(STT_ADAPTERS['whisper-server'].normalize(body), {
    text: 'hello world',
    segments: [{ text: 'hello world', startSec: 0, endSec: 2.48 }],
  })
})

test('whisper-server adapter tolerates the plain {text} /inference?response_format=json shape', () => {
  assert.deepEqual(STT_ADAPTERS['whisper-server'].normalize({ text: 'fake transcript' }), { text: 'fake transcript' })
})

// --- flavor selection: one place chooses the adapter by endpoint kind / api / runtime ---

test('selectSttAdapter: http openai-compat → the OpenAI transcription adapter (/v1/audio/transcriptions, sends model)', () => {
  const ep: Endpoint = { kind: 'http', name: 'x', url: 'http://h', api: 'openai-compat' }
  const adapter = selectSttAdapter(ep)
  assert.equal(adapter?.flavor, 'openai')
  assert.equal(adapter?.request.path, '/v1/audio/transcriptions')
  assert.equal(adapter?.request.sendModel, true)
})

test('selectSttAdapter: http paddle-serving (a non-stt dialect) is unsupported → undefined', () => {
  const ep: Endpoint = { kind: 'http', name: 'x', url: 'http://h', api: 'paddle-serving' }
  assert.equal(selectSttAdapter(ep), undefined)
})

test('selectSttAdapter: local mlx → omlx adapter (sends the served model id); local whisper.cpp → whisper-server (/inference, no model)', () => {
  const mlx: Endpoint = { kind: 'local', name: 'p', runtime: 'mlx', model: 'mlx-community_parakeet-tdt_ctc-110m' }
  const whisper: Endpoint = { kind: 'local', name: 'w', runtime: 'whisper.cpp', model: 'model.bin' }
  assert.equal(selectSttAdapter(mlx)?.flavor, 'omlx')
  assert.equal(selectSttAdapter(mlx)?.request.sendModel, true)
  assert.equal(selectSttAdapter(whisper)?.flavor, 'whisper-server')
  assert.equal(selectSttAdapter(whisper)?.request.path, '/inference')
  assert.equal(selectSttAdapter(whisper)?.request.sendModel, false)
})

test('selectSttAdapter: an unmanaged local runtime (ollama) has no stt adapter → undefined (caller falls through)', () => {
  const ep: Endpoint = { kind: 'local', name: 'o', runtime: 'ollama', model: 'x' }
  assert.equal(selectSttAdapter(ep), undefined)
})
