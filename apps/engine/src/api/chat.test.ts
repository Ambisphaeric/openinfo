import { createServer, type Server } from 'node:http'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Entity, Fabric, PinChunk, RelevantEntity } from '@openinfo/contracts'
import { assembleContext, computeBudget, estimateTokens, runChat, type ChatDeps } from './chat.js'

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

test('assembleContext names relevant entities and cites packed pin chunks', () => {
  const out = assembleContext({
    entities: [rel('Acme', 'org', 'renewal in Q3'), rel('Dana', 'person')],
    pinId: 'pin-1',
    pinTitle: 'contract.txt',
    chunks: [chunk(0, 'the term is 12 months', 4), chunk(1, 'auto-renews unless cancelled', 5)],
  })
  assert.match(out.contextText, /Known in this session:/)
  assert.match(out.contextText, /- Acme \(org\) — renewal in Q3/)
  assert.match(out.contextText, /Excerpts from contract.txt/)
  assert.match(out.contextText, /\[p\.4\] the term is 12 months/)
  assert.equal(out.citations.length, 2)
  assert.deepEqual(out.citations[0], { pinId: 'pin-1', pinTitle: 'contract.txt', ordinal: 0, page: 4, excerpt: 'the term is 12 months' })
  assert.equal(out.truncated, false)
  assert.equal(out.citedChunks, 2)
})

test('assembleContext truncates to the char budget and reports it (honest, never silent)', () => {
  const big = Array.from({ length: 10 }, (_, i) => chunk(i, 'x'.repeat(200), i + 1))
  const out = assembleContext({ entities: [], pinId: 'pin-1', pinTitle: 'big.txt', chunks: big, maxContextChars: 300 })
  assert.equal(out.truncated, true)
  assert.ok(out.citedChunks >= 1 && out.citedChunks < out.totalChunks)
  assert.equal(out.totalChunks, 10)
})

test('assembleContext with nothing known yields an empty context (still answerable)', () => {
  const out = assembleContext({ entities: [], chunks: [] })
  assert.equal(out.contextText, '')
  assert.equal(out.citations.length, 0)
  assert.equal(out.truncated, false)
})

test('computeBudget discloses truncation and an honest turns-remaining estimate', () => {
  const b = computeBudget({ contextTokens: 100, historyTokens: 20, truncated: true, citedChunks: 3, totalChunks: 40 })
  assert.equal(b.contextTokens, 120)
  assert.equal(b.truncated, true)
  assert.match(b.note, /cited 3 of 40 chunks/)
  assert.match(b.note, /useful turn/)
  assert.ok(b.turnsRemaining >= 0)
})

test('estimateTokens is chars/4, zero for empty', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('abcde'), 2)
})

const baseDeps = (fabric: Fabric): ChatDeps => ({
  fabric,
  relevant: () => [rel('Acme', 'org')],
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
    // the system prompt actually carried the corpus (entities + cited excerpt)
    const system = seen.messages.find((m) => m.role === 'system')!.content
    assert.match(system, /Acme/)
    assert.match(system, /the term is 12 months/)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('runChat THROWS on an empty llm slot (the route turns this into visible failure text)', async () => {
  const fabric: Fabric = { slots: { stt: [], tts: [], llm: [], vlm: [], ocr: [], embed: [] } }
  await assert.rejects(() => runChat(baseDeps(fabric), { message: 'hi' }), /llm/i)
})
