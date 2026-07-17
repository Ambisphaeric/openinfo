import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Distillate, Fabric, Session } from '@openinfo/contracts'
import { FabricDocuments, defaultFabric } from '../fabric/index.js'
import { GuardDocuments, GuardHoldStore } from '../guard/index.js'
import { WorkspaceRegistry } from '../store/index.js'
import { DistillDocuments } from '../distill/index.js'
import { createFabricSummarizer, materializeSummaries } from './produce-summaries.js'

/**
 * The SUMMARIZER SEAM privacy gate (#177 × #64), driven through the REAL `createFabricSummarizer` + REAL
 * invokeLlm against fake HTTP endpoints (no injected invoke). It proves the fix for the fresh-eyes finding:
 * the summarizer resolves egress with the SAME four layers the distiller does — in particular LAYER 3, the
 * session's MODE `egress.deny`. A mode that denies egress for distillation must equally hold summary prose:
 * an egress-classified endpoint is NEVER contacted and the summary is persisted DEGRADED (honest reason, no
 * fabricated prose), while a device-local endpoint still summarizes. The #63 guard-hold path is pinned too.
 *
 * MECHANISM mirrors distill/privacy-gate-seam.test.ts: egress reach is classified from the endpoint DOCUMENT
 * url, so an `*.egress.test` host classifies as egress; a global-fetch shim steers ONLY that host family to
 * loopback so the real HTTP call lands on a real counting fake server. Nothing about the summarizer, the
 * egress resolver, or the guard is stubbed; only the network target of an egress-classified host is steered.
 */

const DIALS = { tone: 5, warmth: 5, wit: 5, charm: 5, specificity: 5, brevity: 5 }

interface FakeChat {
  server: Server
  port: number
  hits: () => number
}

const startChat = async (reply: (prompt: string) => string): Promise<FakeChat> => {
  let hits = 0
  const server = createServer((req, res) => {
    const bufs: Buffer[] = []
    req.on('data', (c: Buffer) => bufs.push(c))
    req.on('end', () => {
      hits++
      let prompt = ''
      try {
        const body = JSON.parse(Buffer.concat(bufs).toString('utf8')) as { messages: { content: string }[] }
        prompt = body.messages.map((m) => m.content).join('\n')
      } catch { /* a malformed body is still a hit */ }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply(prompt) } }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, port: address.port, hits: () => hits }
}
const stopChat = (chat: FakeChat): Promise<void> => new Promise((resolve) => chat.server.close(() => resolve()))

/** Steer ONLY `*.egress.test` hosts to loopback so an egress-classified endpoint is reachable at a fake server. */
const installEgressRewrite = (): (() => void) => {
  const real = globalThis.fetch
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    if (typeof raw === 'string') {
      const url = new URL(raw)
      if (url.hostname.endsWith('.egress.test')) {
        url.hostname = '127.0.0.1'
        return real(url.href, init)
      }
    }
    return real(input, init)
  }) as typeof fetch
  return () => { globalThis.fetch = real }
}

interface Rig {
  dir: string
  store: WorkspaceRegistry
  docs: DistillDocuments
  guardDocs: GuardDocuments
  guardHolds: GuardHoldStore
  fabric: FabricDocuments
}
const setup = async (): Promise<Rig> => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-sum-egress-'))
  const store = new WorkspaceRegistry(dir)
  const docs = new DistillDocuments(store)
  docs.ensureDefaults()
  const guardDocs = new GuardDocuments(store)
  guardDocs.ensureDefaults()
  const guardHolds = new GuardHoldStore(store)
  const fabric = new FabricDocuments(store)
  // One session (mode-meeting) with one distillate — the rolling level's only child.
  const session: Session = { id: 'ses-eg', workspaceId: 'default', modeId: 'mode-meeting', startedAt: '2026-07-16T13:00:00.000Z', attribution: { confidence: 1, evidence: [] } }
  store.saveSession(session)
  const at = '2026-07-16T13:00:05.000Z'
  const distillate: Distillate = { id: 'dist-eg', sessionId: 'ses-eg', workspaceId: 'default', windowStart: at, windowEnd: at, sourceChunks: ['c-eg'], text: 'we agreed to ship Thursday', voice: { scope: 'global', dials: DIALS }, provenance: { slot: 'llm', endpoint: 'fake' }, schemaVersion: 1, createdAt: at }
  store.saveDistillate(distillate)
  return { dir, store, docs, guardDocs, guardHolds, fabric }
}
const teardown = async (rig: Rig): Promise<void> => { rig.store.close(); await rm(rig.dir, { recursive: true, force: true }) }
const saveFabric = (rig: Rig, over: Partial<Fabric['slots']>): void => {
  rig.fabric.save({ slots: { ...defaultFabric().slots, ...over } })
}

const runLevels = (rig: Rig, levels: readonly ('rolling' | 'episode' | 'five-minute' | 'session' | 'project')[], extra: Partial<Parameters<typeof createFabricSummarizer>[0]> = {}) =>
  materializeSummaries(
    { store: rig.store, summaryTemplate: (l) => rig.docs.summaryTemplate(l), summarize: createFabricSummarizer({ store: rig.store, fabric: rig.fabric, mode: (id) => rig.docs.mode(id), ...extra }), now: () => new Date('2026-07-16T13:02:00.000Z') },
    { workspaceId: 'default', sessionId: 'ses-eg', trigger: 'session-end', levels },
  )
const runRolling = (rig: Rig, extra: Partial<Parameters<typeof createFabricSummarizer>[0]> = {}) => runLevels(rig, ['rolling'], extra)

test('#177 seam: a DENYING mode holds summary-prose egress (layer 3) — the egress endpoint is never contacted, the summary is DEGRADED', async () => {
  const rig = await setup()
  const restore = installEgressRewrite()
  const egress = await startChat(() => 'they agreed to ship Thursday.')
  try {
    // Mode denies egress (layer 3); the ONLY llm endpoint is egress-classified ⇒ the summary call has
    // nowhere honest to go. It must degrade, not silently leave — exactly as distillation would fail closed.
    rig.docs.saveMode({ ...rig.docs.mode(), egress: { deny: true } })
    saveFabric(rig, { llm: [{ kind: 'http', name: 'llm.hosted', url: `http://llm.egress.test:${egress.port}`, api: 'openai-compat' }] })

    const outcome = await runRolling(rig)
    assert.equal(egress.hits(), 0, 'the egress endpoint was skipped before any byte left the machine')
    assert.equal(outcome.degraded, 1, 'the summary is persisted degraded, not egressed')
    const stored = rig.store.listSummaries('default', { sessionId: 'ses-eg', level: 'rolling' })
    assert.equal(stored.length, 1)
    assert.equal(stored[0]!.text, undefined, 'no fabricated prose when the mode denies the only (egress) endpoint')
    assert.ok(stored[0]!.degraded?.reason && stored[0]!.degraded.reason.length > 0, 'an honest machine-visible reason is recorded')
    assert.equal(stored[0]!.children.length, 1, 'the deterministic derivation path is intact even when degraded')
  } finally {
    await stopChat(egress)
    restore()
    await teardown(rig)
  }
})

test('#177 seam (slice 2): the DENYING mode holds egress at the coarser SESSION level too — every level degrades, nothing leaves', async () => {
  const rig = await setup()
  const restore = installEgressRewrite()
  const egress = await startChat(() => 'they agreed to ship Thursday.')
  try {
    // Extend the layer-3 proof up the hierarchy: the whole rolling→five-minute→session chain runs under a
    // mode that denies egress, and the ONLY llm endpoint is egress-classified. Not one hop may leave — every
    // level is persisted degraded, at EVERY timescale, not just the base level.
    rig.docs.saveMode({ ...rig.docs.mode(), egress: { deny: true } })
    saveFabric(rig, { llm: [{ kind: 'http', name: 'llm.hosted', url: `http://llm.egress.test:${egress.port}`, api: 'openai-compat' }] })

    const outcome = await runLevels(rig, ['rolling', 'five-minute', 'session'])
    assert.equal(egress.hits(), 0, 'the egress endpoint was never contacted at any level')
    assert.ok(outcome.degraded >= 3, 'every level (rolling, five-minute, session) degraded honestly')
    const session = rig.store.listSummaries('default', { sessionId: 'ses-eg', level: 'session' })
    assert.equal(session.length, 1, 'the durable session summary still materialized (structure intact)')
    assert.equal(session[0]!.text, undefined, 'no fabricated session prose when the mode denies the only (egress) endpoint')
    assert.ok(session[0]!.degraded?.reason, 'the session summary carries an honest machine-visible reason')
    assert.ok(session[0]!.children.length >= 1, 'the deterministic derivation path is intact even when degraded')
  } finally {
    await stopChat(egress)
    restore()
    await teardown(rig)
  }
})

test('#177 seam: a device-local endpoint still summarizes under the same denying mode (local reach ignores the deny)', async () => {
  const rig = await setup()
  const restore = installEgressRewrite()
  const local = await startChat(() => 'they agreed to ship Thursday.')
  try {
    rig.docs.saveMode({ ...rig.docs.mode(), egress: { deny: true } })
    saveFabric(rig, { llm: [{ kind: 'http', name: 'llm.local', url: `http://127.0.0.1:${local.port}`, api: 'openai-compat' }] })

    const outcome = await runRolling(rig)
    assert.ok(local.hits() >= 1, 'the device-local endpoint answered — a local hop is not egress-filtered')
    assert.equal(outcome.degraded, 0, 'a local summary is real prose, not degraded')
    const stored = rig.store.listSummaries('default', { sessionId: 'ses-eg', level: 'rolling' })
    assert.equal(stored[0]!.text, 'they agreed to ship Thursday.', 'the local model prose is persisted')
    assert.equal(stored[0]!.provenance.egress?.reach, 'local')
  } finally {
    await stopChat(local)
    restore()
    await teardown(rig)
  }
})

test('#177 seam: a strict guard HOLD on the summary egress hop degrades honestly (GuardHeldError → degraded, nothing left)', async () => {
  const rig = await setup()
  const restore = installEgressRewrite()
  const egress = await startChat(() => 'they agreed to ship Thursday.')
  const guard = await startChat(() => '{"flagged":[{"start":0,"length":4,"kind":"secret"}]}')
  try {
    // Egress allowed (default mode), but the guard holds-and-surfaces a flagged span ⇒ the hop is suspended
    // BEFORE the target is contacted; the summarizer catches GuardHeldError and degrades honestly.
    rig.guardDocs.savePolicy({ id: 'guard-policy', version: 2, behavior: 'hold-and-surface', acknowledgeUnguardedEgress: false })
    saveFabric(rig, {
      llm: [{ kind: 'http', name: 'llm.hosted', url: `http://llm.egress.test:${egress.port}`, api: 'openai-compat' }],
      guard: [{ kind: 'http', name: 'guard.local', url: `http://127.0.0.1:${guard.port}`, api: 'openai-compat' }],
    })
    const outcome = await runRolling(rig, { guardDocs: rig.guardDocs, guardHolds: rig.guardHolds, guardEnabled: () => true })

    assert.equal(egress.hits(), 0, 'the held hop never reached the target — nothing left the machine')
    assert.equal(outcome.degraded, 1)
    const stored = rig.store.listSummaries('default', { sessionId: 'ses-eg', level: 'rolling' })
    assert.equal(stored[0]!.text, undefined, 'a held summary carries no prose')
    assert.match(stored[0]!.degraded!.reason, /guard held/i, 'the degraded reason names the guard hold')
  } finally {
    await stopChat(egress)
    await stopChat(guard)
    restore()
    await teardown(rig)
  }
})
