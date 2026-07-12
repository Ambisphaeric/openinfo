import { createServer, type Server } from 'node:http'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatContextSource, Entity, Fabric, PinChunk, RelevantEntity } from '@openinfo/contracts'
import { BUNDLE_PROMPT, computeBudget, estimateTokens, runChat, type ChatDeps } from './chat.js'
import { DEFAULT_CONTEXT_SOURCES } from './context-assembly.js'

const entity = (name: string, kind: Entity['kind']): Entity => ({
  id: `ent-${name}`, workspaceId: 'default', kind, name, aliases: [], momentRefs: [], outboundCount: 0, mentions: 1,
  firstSeen: '2026-07-10T14:00:00Z', lastSeen: '2026-07-10T14:40:00Z',
})
const rel = (name: string, kind: Entity['kind'], momentText?: string): RelevantEntity => ({
  entity: entity(name, kind), score: 1,
  moments: momentText ? [{ id: 'm', sessionId: 's', workspaceId: 'default', at: '2026-07-10T14:00:00Z', kind: 'context', text: momentText, refs: [], source: 'mic', confidence: 0.8 }] : [],
})
const chunk = (ordinal: number, text: string, page?: number): PinChunk => ({
  id: `c-${ordinal}`, pinId: 'pin-1', workspaceId: 'default', ordinal, ...(page !== undefined ? { page } : {}), text, createdAt: '2026-07-10T14:00:00Z',
})

test('computeBudget prepends the assembly disclosure and an honest turns-remaining estimate', () => {
  const b = computeBudget({ contextTokens: 100, historyTokens: 20, truncated: true, assemblyNote: 'Context: attached-docs(3 of 40, capped). Omitted: insights (empty).' })
  assert.equal(b.contextTokens, 120)
  assert.equal(b.truncated, true)
  assert.match(b.note, /attached-docs\(3 of 40, capped\)/)
  assert.match(b.note, /Omitted: insights \(empty\)/)
  assert.match(b.note, /useful turn/)
  assert.ok(b.turnsRemaining >= 0)
})

test('estimateTokens is chars/4, zero for empty', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('abcde'), 2)
})

const baseDeps = (fabric: Fabric, sources: readonly ChatContextSource[] = DEFAULT_CONTEXT_SOURCES): ChatDeps => ({
  fabric,
  contextSources: sources,
  bundlePrompt: BUNDLE_PROMPT,
  relevant: () => [rel('Acme', 'org')],
  transcript: () => '',
  insights: () => [],
  pinTitle: () => 'contract.txt',
  pinChunks: () => [chunk(0, 'the term is 12 months', 4)],
  workspaceDeniesEgress: () => false,
  resolveKey: () => undefined,
  runtimeManager: undefined as unknown as ChatDeps['runtimeManager'],
})

test('runChat answers over a live openai-compat endpoint with citations + honest budget', async () => {
  // A throwaway openai-compat server — proves the REAL invoke path end-to-end (no mock of invokeLlm).
  const seen: { messages: { role: string; content: string }[] } = { messages: [] }
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.messages = (JSON.parse(body) as { messages: { role: string; content: string }[] }).messages
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'It is a 12-month term [p.4].' } }], usage: { prompt_tokens: 40, completion_tokens: 8 } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const addr = server.address()
  assert.ok(addr && typeof addr === 'object')
  const fabric: Fabric = { slots: { stt: [], tts: [], llm: [{ kind: 'http', name: 'local', url: `http://127.0.0.1:${addr.port}`, api: 'openai-compat' }], vlm: [], ocr: [], embed: [] } }
  try {
    const reply = await runChat(baseDeps(fabric), { message: 'what is the term?', pinId: 'pin-1' })
    assert.match(reply.answer, /12-month term/)
    assert.equal(reply.citations.length, 1)
    assert.equal(reply.citations[0]!.page, 4)
    assert.ok(reply.budget.turnsRemaining >= 0)
    assert.match(reply.budget.note, /useful turn/)
    // the system prompt actually carried the corpus (bundle prompt + entities + cited excerpt)
    const system = seen.messages.find((m) => m.role === 'system')!.content
    assert.match(system, /openinfo assistant/) // the bundle-prompt source
    assert.match(system, /Acme/) // the relevant-entities source
    assert.match(system, /the term is 12 months/) // the attached-docs source
    // the budget note discloses the per-source assembly (what entered, what was omitted and why)
    assert.match(reply.budget.note, /Context:/)
    assert.match(reply.budget.note, /active-preset \(unavailable\)/) // the P2 seam is unfilled — honest
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('runChat obeys a declaration that omits sources — assembly is data, not code', async () => {
  const seen: { messages: { role: string; content: string }[] } = { messages: [] }
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.messages = (JSON.parse(body) as { messages: { role: string; content: string }[] }).messages
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const addr = server.address()
  assert.ok(addr && typeof addr === 'object')
  const fabric: Fabric = { slots: { stt: [], tts: [], llm: [{ kind: 'http', name: 'local', url: `http://127.0.0.1:${addr.port}`, api: 'openai-compat' }], vlm: [], ocr: [], embed: [] } }
  try {
    // A DIFFERENT declaration (only the bundle prompt) ⇒ a DIFFERENT assembly — no code change.
    const reply = await runChat(baseDeps(fabric, [{ kind: 'bundle-prompt' }]), { message: 'hi', pinId: 'pin-1' })
    const system = seen.messages.find((m) => m.role === 'system')!.content
    assert.match(system, /openinfo assistant/)
    assert.doesNotMatch(system, /Acme/) // relevant-entities was NOT declared
    assert.doesNotMatch(system, /the term is 12 months/) // attached-docs was NOT declared
    assert.equal(reply.citations.length, 0) // no attached-docs source ⇒ no citations
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('runChat THROWS on an empty llm slot (the route turns this into visible failure text)', async () => {
  const fabric: Fabric = { slots: { stt: [], tts: [], llm: [], vlm: [], ocr: [], embed: [] } }
  await assert.rejects(() => runChat(baseDeps(fabric), { message: 'hi' }), /llm/i)
})
