import { createServer, type Server } from 'node:http'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Endpoint, Fabric, GuardSpan } from '@openinfo/contracts'
import { defaultFabric } from './document.js'
import { invokeLlm, type LlmMessage } from './invoke.js'
import { resolveEgress } from './egress.js'
import { runEgressGuard, GuardHeldError, type GuardOptions } from './guard.js'

interface FakeServer {
  server: Server
  url: string
  requests: unknown[]
}

/** A fake OpenAI-compat LLM (the egress target / the local fallback). */
const startFakeLlm = async (reply: string): Promise<FakeServer> => {
  const requests: unknown[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply } }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const a = server.address()
  assert.ok(a && typeof a === 'object')
  return { server, url: `http://127.0.0.1:${a.port}`, requests }
}

/**
 * A fake GUARD classifier endpoint (the #63 "fake guard endpoint"): it echoes the flagged spans it was
 * constructed with as the classifier JSON in an OpenAI-compat completion. `status` lets a test force a
 * transport/protocol failure (the fail-closed case). It records the classified user text so a test can
 * confirm the guard saw the OUTBOUND content.
 */
const startFakeGuard = async (flagged: GuardSpan[], status = 200): Promise<FakeServer & { classified: string[] }> => {
  const requests: unknown[] = []
  const classified: string[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages?: { role: string; content: string }[] }
      requests.push(body)
      classified.push(body.messages?.find((m) => m.role === 'user')?.content ?? '')
      res.writeHead(status, { 'content-type': 'application/json' })
      if (status !== 200) return res.end('boom')
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ flagged }) } }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const a = server.address()
  assert.ok(a && typeof a === 'object')
  return { server, url: `http://127.0.0.1:${a.port}`, requests, classified }
}

const stop = (s: FakeServer): Promise<void> => new Promise((resolve) => s.server.close(() => resolve()))

const guardEndpoint = (url: string): Endpoint => ({ kind: 'http', name: 'guard-1', url, api: 'openai-compat' })
const opts = (endpoints: Endpoint[], behavior: GuardOptions['behavior'], ack = false): GuardOptions => ({
  endpoints,
  behavior,
  acknowledgeUnguardedEgress: ack,
})
const messages: LlmMessage[] = [{ role: 'user', content: 'pay to 4111111111111111 now' }]
const cardSpan: GuardSpan = { start: 7, length: 16, kind: 'card-number' }

/** ---------- runEgressGuard against a REAL fake guard endpoint (the DoD "fake guard endpoint") ---------- */

test('redact-and-continue: the fake guard flags a span, the guard MASKS it, and the hop proceeds', async () => {
  const guard = await startFakeGuard([cardSpan])
  try {
    const out = await runEgressGuard(messages, { endpoint: 'hosted', url: 'https://api.example.com' }, opts([guardEndpoint(guard.url)], 'redact-and-continue'))
    assert.equal(out.messages[0]!.content, 'pay to [redacted:card-number] now')
    assert.ok(!out.messages[0]!.content.includes('4111111111111111'), 'the raw card number never survives')
    assert.equal(out.verdict.outcome, 'redacted')
    assert.equal(out.verdict.maskedSpanCount, 1)
    assert.equal(out.verdict.guardEndpoint, 'guard-1')
    assert.equal(guard.classified[0], 'pay to 4111111111111111 now', 'the guard classified the outbound content')
  } finally {
    await stop(guard)
  }
})

test('clean: the fake guard flags nothing, content is unchanged, verdict is clean', async () => {
  const guard = await startFakeGuard([])
  try {
    const out = await runEgressGuard(messages, { endpoint: 'hosted', url: 'https://api.example.com' }, opts([guardEndpoint(guard.url)], 'redact-and-continue'))
    assert.equal(out.messages[0]!.content, 'pay to 4111111111111111 now')
    assert.equal(out.verdict.outcome, 'clean')
    assert.equal(out.verdict.maskedSpanCount, 0)
  } finally {
    await stop(guard)
  }
})

test('hold-and-surface: the fake guard flags a span, strict mode HOLDS (throws GuardHeldError with spans)', async () => {
  const guard = await startFakeGuard([cardSpan])
  try {
    await assert.rejects(
      () => runEgressGuard(messages, { endpoint: 'hosted', url: 'https://api.example.com' }, opts([guardEndpoint(guard.url)], 'hold-and-surface')),
      (err: unknown) => {
        assert.ok(err instanceof GuardHeldError)
        assert.equal(err.verdict.outcome, 'held')
        assert.equal(err.verdict.maskedSpanCount, 1)
        assert.deepEqual(err.verdict.spans, [cardSpan])
        return true
      },
    )
  } finally {
    await stop(guard)
  }
})

test('fail closed: a configured guard that ERRORS holds the hop (never lets content leave unguarded)', async () => {
  const guard = await startFakeGuard([cardSpan], 500)
  try {
    await assert.rejects(
      () => runEgressGuard(messages, { endpoint: 'hosted', url: 'https://api.example.com' }, opts([guardEndpoint(guard.url)], 'redact-and-continue')),
      (err: unknown) => {
        assert.ok(err instanceof GuardHeldError)
        assert.equal(err.verdict.outcome, 'held')
        assert.equal(err.verdict.guarded, false)
        return true
      },
    )
  } finally {
    await stop(guard)
  }
})

/** ---------- invokeLlm wiring: the guard runs ONLY on egress hops, and a hold is a hard stop ---------- */

const egressFabric = (guard: Endpoint[]): Fabric => ({
  slots: { ...defaultFabric().slots, llm: [{ kind: 'http', name: 'hosted', url: 'https://api.example.com', api: 'openai-compat' }], guard },
})

test('invokeLlm: an egress hop + strict guard that flags → throws GuardHeldError (the egress endpoint is never called)', async () => {
  const guard = await startFakeGuard([cardSpan])
  try {
    await assert.rejects(
      () => invokeLlm(egressFabric([guardEndpoint(guard.url)]), messages, { egress: resolveEgress({ contentClass: 'transcript' }), guard: opts([guardEndpoint(guard.url)], 'hold-and-surface') }),
      (err: unknown) => err instanceof GuardHeldError,
    )
  } finally {
    await stop(guard)
  }
})

test('invokeLlm: an empty guard slot + default + NOT acknowledged → egress HOLDS (fail closed, hard stop)', async () => {
  await assert.rejects(
    () => invokeLlm(egressFabric([]), messages, { egress: resolveEgress({ contentClass: 'transcript' }), guard: opts([], 'redact-and-continue', false) }),
    (err: unknown) => err instanceof GuardHeldError,
  )
})

test('invokeLlm: a LOCAL hop never invokes the guard, even with a strict policy (no egress ⇒ no filter)', async () => {
  const local = await startFakeLlm('answered locally')
  const guard = await startFakeGuard([cardSpan])
  try {
    const fabric: Fabric = { slots: { ...defaultFabric().slots, llm: [{ kind: 'http', name: 'loc', url: local.url, api: 'openai-compat' }], guard: [guardEndpoint(guard.url)] } }
    const result = await invokeLlm(fabric, messages, { egress: resolveEgress({ contentClass: 'transcript' }), guard: opts([guardEndpoint(guard.url)], 'hold-and-surface') })
    assert.equal(result.endpoint, 'loc')
    assert.equal(result.guard, undefined, 'no guard verdict on a local hop')
    assert.equal(guard.requests.length, 0, 'the guard classifier was never called for a local hop')
  } finally {
    await stop(local)
    await stop(guard)
  }
})
