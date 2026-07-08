import { createServer, type Server } from 'node:http'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CapabilityMap, ProbeList } from '@openinfo/contracts'
import { classifyModel, discoverFabric, modelSizeRank, synthesizeSuggestion } from './discover.js'
import { seededCapabilityMap } from './discovery-defaults.js'

const MAP = seededCapabilityMap

// --- classifyModel (pure) ---

test('classifyModel: default (no rule) is llm', () => {
  assert.deepEqual(classifyModel(MAP, 'qwen3.6-35b-a3b'), ['llm'])
  assert.deepEqual(classifyModel(MAP, 'gemma-4-12b-it'), ['llm'])
})

test('classifyModel: name patterns → the right non-llm slot', () => {
  assert.deepEqual(classifyModel(MAP, 'glm-ocr@q8_0'), ['ocr'])
  assert.deepEqual(classifyModel(MAP, 'text-embedding-nomic-embed-text-v1.5'), ['embed'])
  assert.deepEqual(classifyModel(MAP, 'whisper-large-v3'), ['stt'])
  assert.deepEqual(classifyModel(MAP, 'parakeet-110m'), ['stt'])
  assert.deepEqual(classifyModel(MAP, 'kokoro-82m'), ['tts'])
})

test('classifyModel: a VL model maps to BOTH vlm and llm (multi-slot union, canonical order)', () => {
  assert.deepEqual(classifyModel(MAP, 'qwen2.5-vl-7b-instruct'), ['llm', 'vlm'])
  assert.deepEqual(classifyModel(MAP, 'MiniCPM-Vision'), ['llm', 'vlm'])
})

// --- synthesizeSuggestion (pure) ---

const server = (over: Partial<import('@openinfo/contracts').DiscoverResult['servers'][number]>) => ({
  name: 'lm-studio', url: 'http://localhost:1234', reachable: true, models: [], ...over,
})

test('synthesizeSuggestion: one best endpoint per slot; unreachable servers contribute nothing', () => {
  const suggestion = synthesizeSuggestion([
    server({
      models: [
        { id: 'qwen3-8b', slots: ['llm'] },
        { id: 'glm-ocr', slots: ['ocr'] },
        { id: 'nomic-embed', slots: ['embed'] },
      ],
    }),
    server({ name: 'kokoro', url: 'http://localhost:8880', reachable: false, models: [] }),
  ])
  assert.equal(suggestion.slots.llm.length, 1)
  assert.equal(suggestion.slots.llm[0]!.kind === 'http' && suggestion.slots.llm[0]!.model, 'qwen3-8b')
  assert.equal(suggestion.slots.ocr[0]!.kind === 'http' && suggestion.slots.ocr[0]!.model, 'glm-ocr')
  assert.equal(suggestion.slots.embed[0]!.kind === 'http' && suggestion.slots.embed[0]!.model, 'nomic-embed')
  assert.deepEqual(suggestion.slots.stt, [])
  assert.deepEqual(suggestion.slots.tts, [])
})

test('synthesizeSuggestion: llm prefers a PURE chat model over a multi-slot VL model', () => {
  const suggestion = synthesizeSuggestion([
    server({
      models: [
        { id: 'qwen2.5-vl-7b', slots: ['llm', 'vlm'] }, // appears first, but is multi-slot
        { id: 'qwen3-8b', slots: ['llm'] }, // pure chat — should win for llm
      ],
    }),
  ])
  assert.equal(suggestion.slots.llm[0]!.kind === 'http' && suggestion.slots.llm[0]!.model, 'qwen3-8b')
  // the VL model still fills vlm
  assert.equal(suggestion.slots.vlm[0]!.kind === 'http' && suggestion.slots.vlm[0]!.model, 'qwen2.5-vl-7b')
})

// --- the cold-35B fix: prefer smaller/likely-warm models for the first-run suggestion ---

test('modelSizeRank: parses NNb/NNm; unknown ranks last', () => {
  assert.equal(modelSizeRank('ornith-1.0-35b-mtplx'), 35000)
  assert.equal(modelSizeRank('qwen2.5-1.5b-instruct'), 1500)
  assert.equal(modelSizeRank('llama-3.2-3b'), 3000)
  assert.equal(modelSizeRank('parakeet-110m'), 110)
  assert.equal(modelSizeRank('lfm2.5-8b-a1b-mlx'), 8000) // first size token (nominal, not active-param)
  assert.equal(modelSizeRank('gemma-instruct'), Number.POSITIVE_INFINITY)
})

test('synthesizeSuggestion: a 35b loses to a 4b for the first-run llm (cold-35B fix)', () => {
  const suggestion = synthesizeSuggestion([
    server({
      models: [
        { id: 'ornith-1.0-35b', slots: ['llm'] }, // appears first, but is huge + cold
        { id: 'qwen2.5-4b-instruct', slots: ['llm'] }, // smaller → should win
      ],
    }),
  ])
  assert.equal(suggestion.slots.llm[0]!.kind === 'http' && suggestion.slots.llm[0]!.model, 'qwen2.5-4b-instruct')
})

test('synthesizeSuggestion: smallest wins across servers; order breaks ties', () => {
  const suggestion = synthesizeSuggestion([
    server({ name: 'a', url: 'http://a', models: [{ id: 'big-70b', slots: ['llm'] }] }),
    server({ name: 'b', url: 'http://b', models: [{ id: 'small-1.5b', slots: ['llm'] }, { id: 'also-1.5b', slots: ['llm'] }] }),
  ])
  // 1.5b beats 70b; between the two 1.5b, discovery order keeps the first
  assert.equal(suggestion.slots.llm[0]!.kind === 'http' && suggestion.slots.llm[0]!.model, 'small-1.5b')
})

test('synthesizeSuggestion: with only a VL model, it fills BOTH llm and vlm', () => {
  const suggestion = synthesizeSuggestion([server({ models: [{ id: 'qwen2.5-vl-7b', slots: ['llm', 'vlm'] }] })])
  assert.equal(suggestion.slots.llm[0]!.kind === 'http' && suggestion.slots.llm[0]!.model, 'qwen2.5-vl-7b')
  assert.equal(suggestion.slots.vlm[0]!.kind === 'http' && suggestion.slots.vlm[0]!.model, 'qwen2.5-vl-7b')
})

// --- discoverFabric (network, fake in-process servers) ---

interface Fake {
  server: Server
  url: string
}
const startFake = async (handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<Fake> => {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, url: `http://127.0.0.1:${address.port}` }
}
const stop = (f: Fake): Promise<void> => new Promise((resolve) => f.server.close(() => resolve()))

const okModels = (ids: string[]) => (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
  assert.equal(req.url, '/v1/models')
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) }))
}

const probeList = (probes: ProbeList['probes']): ProbeList => ({ id: 'test-probes', version: 1, probes })

test('discoverFabric: classifies every model across servers and synthesizes a suggestion', async () => {
  const lm = await startFake(okModels(['qwen3.6-35b-a3b', 'glm-ocr', 'qwen2.5-vl-7b', 'nomic-embed-text']))
  const wh = await startFake(okModels(['whisper-large-v3']))
  try {
    const result = await discoverFabric(probeList([
      { name: 'lm-studio', url: lm.url },
      { name: 'whisper', url: wh.url },
    ]), seededCapabilityMap, { timeoutMs: 1_000 })

    const lmServer = result.servers.find((s) => s.name === 'lm-studio')!
    assert.equal(lmServer.reachable, true)
    assert.equal(lmServer.models.length, 4)
    assert.deepEqual(lmServer.models.find((m) => m.id === 'glm-ocr')!.slots, ['ocr'])
    assert.deepEqual(lmServer.models.find((m) => m.id === 'qwen2.5-vl-7b')!.slots, ['llm', 'vlm'])

    // suggestion: llm from lm-studio (pure qwen3.6), stt from the whisper box, ocr+embed+vlm from lm-studio
    assert.equal(result.suggestion.slots.llm[0]!.kind === 'http' && result.suggestion.slots.llm[0]!.model, 'qwen3.6-35b-a3b')
    assert.equal(result.suggestion.slots.stt[0]!.kind === 'http' && result.suggestion.slots.stt[0]!.name, 'whisper')
    assert.equal(result.suggestion.slots.ocr[0]!.kind === 'http' && result.suggestion.slots.ocr[0]!.model, 'glm-ocr')
    assert.equal(result.suggestion.slots.embed.length, 1)
    assert.equal(result.suggestion.slots.vlm[0]!.kind === 'http' && result.suggestion.slots.vlm[0]!.model, 'qwen2.5-vl-7b')
    assert.ok(result.probedAt)
  } finally {
    await stop(lm)
    await stop(wh)
  }
})

test('discoverFabric: an unreachable server is reported, never throws', async () => {
  const result = await discoverFabric(
    probeList([{ name: 'dead', url: 'http://127.0.0.1:1' }]),
    seededCapabilityMap,
    { timeoutMs: 500 },
  )
  assert.equal(result.servers.length, 1)
  assert.equal(result.servers[0]!.reachable, false)
  assert.ok(result.servers[0]!.error)
  // no candidates → an empty (but valid) suggestion
  assert.deepEqual(result.suggestion.slots.llm, [])
})

test('discoverFabric: a malformed /v1/models (no data array) is reachable:false with an honest error', async () => {
  const bad = await startFake((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: null })) // the real Ollama-with-no-models shape
  })
  const notJson = await startFake((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html>not a model server</html>')
  })
  try {
    const result = await discoverFabric(probeList([
      { name: 'ollama', url: bad.url },
      { name: 'random-web', url: notJson.url },
    ]), seededCapabilityMap, { timeoutMs: 1_000 })
    assert.equal(result.servers[0]!.reachable, false)
    assert.match(result.servers[0]!.error!, /data array/)
    assert.equal(result.servers[1]!.reachable, false)
    assert.match(result.servers[1]!.error!, /invalid JSON|data array/)
  } finally {
    await stop(bad)
    await stop(notJson)
  }
})
