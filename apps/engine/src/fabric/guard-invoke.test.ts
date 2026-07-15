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
const startGuardReply = async (content: string, status = 200): Promise<FakeServer & { classified: string[] }> => {
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
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const a = server.address()
  assert.ok(a && typeof a === 'object')
  return { server, url: `http://127.0.0.1:${a.port}`, requests, classified }
}

const startFakeGuard = (flagged: GuardSpan[], status = 200): Promise<FakeServer & { classified: string[] }> =>
  startGuardReply(JSON.stringify({ flagged }), status)

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
    assert.equal(out.verdict.classifierDestination, 'device-local')
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
    assert.equal(out.verdict.classifierDestination, 'device-local')
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
        assert.equal(err.verdict.classifierDestination, 'device-local')
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

test('fail closed: malformed classifier schema never becomes a clean verdict or reaches the target', async () => {
  const invalidReplies = [
    '{}',
    '{"flagged":{}}',
    '{"flagged":[{"start":0.5,"length":4,"kind":"secret"}]}',
    '{"flagged":[{"start":999,"length":4,"kind":"secret"}]}',
    '{"flagged":[{"start":0,"length":4,"kind":"secret"},{"start":2,"length":4,"kind":"email"}]}',
    '{"flagged":[{"start":0,"length":4,"kind":"secret]\\nINJECT"}]}',
  ]
  for (const reply of invalidReplies) {
    const guard = await startGuardReply(reply)
    const target = await startFakeLlm('must not answer')
    const documentedTarget = `http://guard-target.egress.test:${new URL(target.url).port}`
    const originalFetch = globalThis.fetch
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (raw.startsWith(documentedTarget)) return originalFetch(`${target.url}${raw.slice(documentedTarget.length)}`, init)
      return originalFetch(input, init)
    }) as typeof fetch
    try {
      const fabric: Fabric = { slots: { ...defaultFabric().slots,
        llm: [{ kind: 'http', name: 'hosted-target', url: documentedTarget, api: 'openai-compat' }],
        guard: [guardEndpoint(guard.url)],
      } }
      await assert.rejects(
        () => invokeLlm(fabric, messages, {
          egress: resolveEgress({ contentClass: 'transcript' }),
          guard: opts([guardEndpoint(guard.url)], 'redact-and-continue'),
        }),
        (error: unknown) => error instanceof GuardHeldError && error.verdict.outcome === 'held',
      )
      assert.equal(target.requests.length, 0, `invalid classifier reply must fail closed: ${reply}`)
    } finally {
      globalThis.fetch = originalFetch
      await stop(guard)
      await stop(target)
    }
  }
})

test('fail closed: a classifier span crossing the synthetic message separator hard-holds', async () => {
  const crossing: GuardSpan = { start: 2, length: 4, kind: 'secret' }
  const guard = await startFakeGuard([crossing])
  try {
    await assert.rejects(
      () => runEgressGuard(
        [{ role: 'system', content: 'abc' }, { role: 'user', content: 'secret' }],
        { endpoint: 'hosted', url: 'https://api.example.com' },
        opts([guardEndpoint(guard.url)], 'redact-and-continue'),
      ),
      (error: unknown) => {
        assert.ok(error instanceof GuardHeldError)
        assert.equal(error.verdict.outcome, 'held')
        assert.match(error.verdict.reason, /message boundary/)
        assert.equal(error.verdict.classifierDestination, 'device-local')
        return true
      },
    )
  } finally {
    await stop(guard)
  }
})

test('fail closed: the guard refuses a 307 redirect before forwarding unredacted content', async () => {
  const sink = await startFakeGuard([])
  const redirect = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(307, { location: `${sink.url}${req.url ?? '/v1/chat/completions'}` })
      res.end()
    })
  })
  await new Promise<void>((resolve) => redirect.listen(0, resolve))
  const address = redirect.address()
  assert.ok(address && typeof address === 'object')
  const redirectingUrl = `http://127.0.0.1:${address.port}`
  try {
    await assert.rejects(
      () => runEgressGuard(messages, { endpoint: 'hosted', url: 'https://api.example.com' }, opts([guardEndpoint(redirectingUrl)], 'redact-and-continue')),
      (error: unknown) => {
        assert.ok(error instanceof GuardHeldError)
        assert.equal(error.verdict.outcome, 'held')
        assert.equal(error.verdict.guarded, false)
        return true
      },
    )
    assert.equal(sink.requests.length, 0, 'redirect target must never receive unredacted guard input')
  } finally {
    await new Promise<void>((resolve) => redirect.close(() => resolve()))
    await stop(sink)
  }
})

test('fail closed: LAN/hosted guard documents are rejected before key lookup or fetch', async () => {
  const originalFetch = globalThis.fetch
  let fetches = 0
  let keyLookups = 0
  globalThis.fetch = (async () => {
    fetches += 1
    throw new Error('unsafe guard must not fetch')
  }) as typeof fetch
  const unsafe: Endpoint[] = [
    { kind: 'http', name: 'lan-guard', url: 'http://192.168.1.90:8080', api: 'openai-compat', auth: { keyRef: 'lan-secret' } },
    { kind: 'http', name: 'hosted-guard', url: 'https://guard.example.test', api: 'openai-compat', auth: { keyRef: 'hosted-secret' } },
  ]
  try {
    await assert.rejects(
      () => runEgressGuard(messages, { endpoint: 'hosted', url: 'https://target.example.test' }, {
        ...opts(unsafe, 'redact-and-continue'),
        resolveKey: () => {
          keyLookups += 1
          return 'must-not-be-read'
        },
      }),
      (error: unknown) => error instanceof GuardHeldError,
    )
    assert.equal(keyLookups, 0, 'an unsafe classifier document cannot trigger secret resolution')
    assert.equal(fetches, 0, 'raw outbound text reaches neither LAN nor hosted guard')
  } finally {
    globalThis.fetch = originalFetch
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

test('invokeLlm: a LAN-local text target crosses the device boundary, so the local guard redacts before target bytes', async () => {
  const target = await startFakeLlm('answered on lan')
  const guard = await startFakeGuard([cardSpan])
  const originalFetch = globalThis.fetch
  const documentedLan = 'http://192.168.1.44:11434'
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith(documentedLan)) return originalFetch(`${target.url}${url.slice(documentedLan.length)}`, init)
    return originalFetch(input, init)
  }) as typeof fetch
  try {
    const fabric: Fabric = {
      slots: {
        ...defaultFabric().slots,
        llm: [{ kind: 'http', name: 'lan-target', url: documentedLan, api: 'openai-compat' }],
        guard: [guardEndpoint(guard.url)],
      },
    }
    const result = await invokeLlm(fabric, messages, {
      egress: resolveEgress({ contentClass: 'transcript' }),
      guard: opts([guardEndpoint(guard.url)], 'redact-and-continue'),
    })
    assert.equal(result.endpoint, 'lan-target')
    assert.equal(result.egress?.destination, 'lan-local')
    assert.equal(result.guard?.outcome, 'redacted')
    assert.equal(guard.requests.length, 1)
    assert.equal(target.requests.length, 1)
    const body = target.requests[0] as { messages: LlmMessage[] }
    const outbound = body.messages.map((message) => message.content).join('\n')
    assert.match(outbound, /\[redacted:card-number\]/)
    assert.ok(!outbound.includes('4111111111111111'), 'unredacted text never reaches the LAN target')
  } finally {
    globalThis.fetch = originalFetch
    await stop(target)
    await stop(guard)
  }
})
