import { createServer, type Server } from 'node:http'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Fabric } from '@openinfo/contracts'
import { defaultFabric } from './document.js'
import { invokeLlm } from './invoke.js'
import { AggregateInvokeError, classifyHttpResponse, extractServerMessage } from './invoke-error.js'
import { listLoadedModels, loadedModelSuggestion } from './discover.js'

interface Fake {
  server: Server
  url: string
}

/** A fake completions server whose status + body we control (models list optional, for suggestions). */
const startFake = async (status: number, body: string, modelIds?: string[]): Promise<Fake> => {
  const server = createServer((req, res) => {
    if (modelIds && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: modelIds.map((id) => ({ id })) }))
      return
    }
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, url: `http://127.0.0.1:${address.port}` }
}

const stop = (f: Fake): Promise<void> => new Promise((resolve) => f.server.close(() => resolve()))

const fabricWith = (url: string, name = 'llm', model?: string): Fabric => ({
  slots: { ...defaultFabric().slots, llm: [{ kind: 'http', name, url, api: 'openai-compat', ...(model ? { model } : {}) }] },
})

/** Invoke and return the AggregateInvokeError it throws (asserting it threw). */
const failureOf = async (fabric: Fabric): Promise<AggregateInvokeError> => {
  try {
    await invokeLlm(fabric, [{ role: 'user', content: 'x' }], { timeoutMs: 600 })
  } catch (error) {
    assert.ok(error instanceof AggregateInvokeError, 'expected an AggregateInvokeError')
    return error
  }
  throw new Error('expected invokeLlm to throw')
}

test('classify: unreachable — nothing listening (ECONNREFUSED)', async () => {
  const agg = await failureOf(fabricWith('http://127.0.0.1:1'))
  assert.equal(agg.failures[0]?.class, 'unreachable')
  assert.match(agg.failures[0]!.hint, /check the URL/)
})

test('classify: timeout — the server never answers within the timeout', async () => {
  const server = createServer(() => {
    /* never respond */
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  try {
    const agg = await failureOf(fabricWith(`http://127.0.0.1:${address.port}`))
    assert.equal(agg.failures[0]?.class, 'timeout')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('classify: auth — HTTP 401 names the keyRef, never a value', async () => {
  const fake = await startFake(401, JSON.stringify({ error: 'invalid api key' }))
  try {
    const fabric: Fabric = {
      slots: {
        ...defaultFabric().slots,
        llm: [{ kind: 'http', name: 'authed', url: fake.url, api: 'openai-compat', auth: { keyRef: 'remote-llm-key' } }],
      },
    }
    const agg = await failureOf(fabric)
    assert.equal(agg.failures[0]?.class, 'auth')
    assert.equal(agg.failures[0]?.keyRef, 'remote-llm-key')
    assert.match(agg.failures[0]!.hint, /remote-llm-key/)
    assert.ok(!JSON.stringify(agg.failures[0]).includes('sk-'), 'no secret value leaks')
  } finally {
    await stop(fake)
  }
})

test('classify: auth — an unresolvable keyRef fails BEFORE any fetch, naming the ref', async () => {
  const fabric: Fabric = {
    slots: {
      ...defaultFabric().slots,
      llm: [{ kind: 'http', name: 'authed', url: 'http://127.0.0.1:1', api: 'openai-compat', auth: { keyRef: 'absent-key' } }],
    },
  }
  const agg = await failureOf(fabric)
  assert.equal(agg.failures[0]?.class, 'auth')
  assert.match(agg.failures[0]!.hint, /absent-key/)
})

test("classify: model-load — LM Studio's verbatim 400 body is captured and classified", async () => {
  // The exact shape LM Studio returns when a model fails to load (the user's wall).
  const lmStudioBody = JSON.stringify({ error: 'Model "qwen3.5-35b" failed to load. Error: llama.cpp error: failed to allocate buffer' })
  const fake = await startFake(400, lmStudioBody)
  try {
    const agg = await failureOf(fabricWith(fake.url, 'lm-studio', 'qwen3.5-35b'))
    const f = agg.failures[0]!
    assert.equal(f.class, 'model-load')
    assert.match(f.serverMessage ?? '', /failed to load/)
    assert.match(f.hint, /pick a smaller\/loaded model/)
  } finally {
    await stop(fake)
  }
})

test('classify: model-load — a plain 500 is treated as a server/model failure', async () => {
  const fake = await startFake(500, 'internal error')
  try {
    const agg = await failureOf(fabricWith(fake.url))
    assert.equal(agg.failures[0]?.class, 'model-load')
  } finally {
    await stop(fake)
  }
})

test('classify: bad-response — 200 with no completion content', async () => {
  const fake = await startFake(200, JSON.stringify({ choices: [] }))
  try {
    const agg = await failureOf(fabricWith(fake.url))
    assert.equal(agg.failures[0]?.class, 'bad-response')
  } finally {
    await stop(fake)
  }
})

test('classify: bad-response — non-JSON body on a 200', async () => {
  const fake = await startFake(200, 'not json at all')
  try {
    const agg = await failureOf(fabricWith(fake.url))
    assert.equal(agg.failures[0]?.class, 'bad-response')
  } finally {
    await stop(fake)
  }
})

test("classify: reasoning-exhausted — LM Studio's 200 with empty content + reasoning_content + finish_reason length", async () => {
  // The user's second confusing failure: qwen3.5-9b burns its whole budget thinking, returns content ''.
  const body = JSON.stringify({
    choices: [{ message: { role: 'assistant', content: '', reasoning_content: 'let me think about this…'.repeat(20) }, finish_reason: 'length' }],
  })
  const fake = await startFake(200, body)
  try {
    const agg = await failureOf(fabricWith(fake.url, 'lm-studio', 'qwen3.5-9b'))
    const f = agg.failures[0]!
    assert.equal(f.class, 'reasoning-exhausted')
    assert.match(f.hint, /spent its entire token budget thinking/)
    assert.match(f.hint, /non-reasoning instruct model|raise the mode's token budget/)
  } finally {
    await stop(fake)
  }
})

test('classify: reasoning-exhausted — a MISSING content field with finish_reason length (omlx omits the key)', async () => {
  // omlx omits `message.content` entirely — instead of sending '' — when every generated token went to
  // reasoning. Same exhaustion, different wire shape; it must classify the same, not as bad-response.
  const body = JSON.stringify({ choices: [{ message: { role: 'assistant' }, finish_reason: 'length' }] })
  const fake = await startFake(200, body)
  try {
    const agg = await failureOf(fabricWith(fake.url, 'omlx', 'lfm2.5-8b-a1b'))
    const f = agg.failures[0]!
    assert.equal(f.class, 'reasoning-exhausted')
    assert.match(f.hint, /spent its entire token budget thinking/)
  } finally {
    await stop(fake)
  }
})

test('reasoning-exhausted is NOT confused with bad-response: empty content WITHOUT the reasoning tells is bad-response-free', async () => {
  // finish_reason 'stop' + empty content + no reasoning_content ⇒ a legitimate empty completion, returned as ''.
  const body = JSON.stringify({ choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] })
  const fake = await startFake(200, body)
  try {
    const result = await invokeLlm(fabricWith(fake.url), [{ role: 'user', content: 'x' }], { timeoutMs: 600 })
    assert.equal(result.text, '')
  } finally {
    await stop(fake)
  }
})

test('fall-through PRESERVES the classes: every failed endpoint keeps its class in order', async () => {
  const unauth = await startFake(401, JSON.stringify({ error: 'nope' }))
  const modelLoad = await startFake(400, JSON.stringify({ error: 'failed to load model' }))
  try {
    const fabric: Fabric = {
      slots: {
        ...defaultFabric().slots,
        llm: [
          { kind: 'http', name: 'a', url: unauth.url, api: 'openai-compat' },
          { kind: 'http', name: 'b', url: modelLoad.url, api: 'openai-compat' },
        ],
      },
    }
    const agg = await failureOf(fabric)
    assert.deepEqual(agg.failures.map((f) => f.class), ['auth', 'model-load'])
    assert.deepEqual(agg.failures.map((f) => f.endpoint), ['a', 'b'])
  } finally {
    await stop(unauth)
    await stop(modelLoad)
  }
})

test('fall-through still WORKS: a broken first endpoint falls through to a healthy one', async () => {
  const broken = await startFake(400, JSON.stringify({ error: 'failed to load' }))
  const good = await startFake(200, JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
  try {
    const fabric: Fabric = {
      slots: {
        ...defaultFabric().slots,
        llm: [
          { kind: 'http', name: 'broken', url: broken.url, api: 'openai-compat' },
          { kind: 'http', name: 'good', url: good.url, api: 'openai-compat' },
        ],
      },
    }
    const result = await invokeLlm(fabric, [{ role: 'user', content: 'x' }], { timeoutMs: 600 })
    assert.equal(result.text, 'ok')
    assert.equal(result.endpoint, 'good')
  } finally {
    await stop(broken)
    await stop(good)
  }
})

test('classifyHttpResponse + extractServerMessage are pure over the LM Studio body', () => {
  const body = JSON.stringify({ error: { message: 'Model failed to load' } })
  assert.equal(extractServerMessage(body), 'Model failed to load')
  const err = classifyHttpResponse(400, body, { endpoint: 'lm', url: 'http://x', model: 'm' })
  assert.equal(err.class, 'model-load')
  assert.equal(err.serverMessage, 'Model failed to load')
})

test('loaded-model suggestion: names OTHER models the server reports (never the failed one)', async () => {
  const fake = await startFake(400, JSON.stringify({ error: 'failed to load' }), ['qwen3.5-35b', 'qwen3.5-9b', 'whisper-large'])
  try {
    assert.deepEqual(await listLoadedModels(fake.url), ['qwen3.5-35b', 'qwen3.5-9b', 'whisper-large'])
    const suggestion = await loadedModelSuggestion(fake.url, 'qwen3.5-35b')
    assert.match(suggestion ?? '', /2 other models/)
    assert.match(suggestion ?? '', /qwen3.5-9b/)
    assert.ok(!suggestion!.includes('qwen3.5-35b, '), 'the failed model is excluded from the examples')
  } finally {
    await stop(fake)
  }
})

test('loaded-model suggestion: undefined when the server reports nothing else', async () => {
  const fake = await startFake(400, JSON.stringify({ error: 'failed to load' }), ['only-me'])
  try {
    assert.equal(await loadedModelSuggestion(fake.url, 'only-me'), undefined)
  } finally {
    await stop(fake)
  }
})
