import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk, Fabric, GuardHold } from '@openinfo/contracts'
import { FabricDocuments, defaultFabric } from '../fabric/index.js'
import { GuardDocuments, GuardHoldStore } from '../guard/index.js'
import { WorkspaceRegistry } from '../store/index.js'
import { VoiceDocuments } from '../voice/index.js'
import { buildLedger, renderLedger } from '../surfaces/settings/sections/ledger.js'
import type { SetupData } from '../surfaces/setup/view.js'
import { Distiller } from './distiller.js'
import { DistillDocuments } from './documents.js'

/**
 * #91 — the DISTILLER SEAM privacy gate, driven through the REAL Distiller + REAL invokeLlm against fake
 * HTTP endpoints (no injected invoke, no mocked distiller). This proves what was previously only code-read:
 *
 *  - the #64 egress consent rides EVERY llm call the window makes (summary + moments + entities) — a denial
 *    is enforced uniformly and an egress-classified endpoint is NEVER contacted; a new extraction call that
 *    dropped the wrapper would light up the egress server's hit counter (the issue's core regression fear);
 *  - a LOCAL hop is neither consent-filtered nor guarded (no egress ⇒ no filter);
 *  - the #63 egress guard runs on every egress hop end-to-end (clean / redacted / held), and a HOLD verdict
 *    actually suspends the hop, records a durable GuardHold, and surfaces it (holds store + ledger column),
 *    with release/deny behaving;
 *  - the ledger renders exactly what this seam produces (current ledger — egress + guard columns + held block).
 *
 * MECHANISM (a fake endpoint, honest transport): egress reach is classified from the endpoint DOCUMENT url,
 * so an `*.egress.test` host classifies as egress (classifyEndpoint reads the doc, not the socket). A tiny
 * global-fetch shim rewrites ONLY that host family to loopback so the real HTTP call lands on a real fake
 * server — exactly what a DNS entry for a reachable public host would do. Nothing about the distiller, the
 * egress resolver, or the guard is stubbed; only the network target of an egress-classified host is steered
 * to a local counting server. Restored in teardown.
 */

interface FakeChat {
  server: Server
  port: number
  hits: () => number
  prompts: () => string[]
}

/** A counting OpenAI-compat chat server bound to loopback; `reply(joinedPrompt)` decides the content. */
const startChat = async (reply: (prompt: string) => string): Promise<FakeChat> => {
  const prompts: string[] = []
  const server = createServer((req, res) => {
    const bufs: Buffer[] = []
    req.on('data', (c: Buffer) => bufs.push(c))
    req.on('end', () => {
      let prompt = ''
      try {
        const body = JSON.parse(Buffer.concat(bufs).toString('utf8')) as { messages: { content: string }[] }
        prompt = body.messages.map((m) => m.content).join('\n')
      } catch {
        /* a malformed body is still a hit; the empty prompt is fine for the counters */
      }
      prompts.push(prompt)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply(prompt) } }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, port: address.port, hits: () => prompts.length, prompts: () => prompts }
}

const stopChat = (chat: FakeChat): Promise<void> => new Promise((resolve) => chat.server.close(() => resolve()))

/** The distill LLM reply: one fake model, three jobs told apart by their template bodies (mirrors pipeline.test). */
const llmReply = (prompt: string): string =>
  prompt.includes('JSON array of entities')
    ? '[{"kind": "person", "name": "Dana"}]'
    : prompt.includes('Return ONLY a JSON array')
      ? '[{"kind": "commitment", "text": "ship Thursday", "confidence": 0.8}]'
      : 'SUMMARY: they agreed to ship Thursday.'

/** Steer ONLY `*.egress.test` hosts to loopback so an egress-classified endpoint is reachable at a fake
 * server. Returns a restore fn. The egress CLASSIFICATION still reads the document url (unrewritten). */
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
  return () => {
    globalThis.fetch = real
  }
}

const chunk = (sequence: number, sec: number, data: string): CaptureChunk => ({
  id: `chunk-${sequence}`,
  sessionId: 'ses-gate',
  workspaceId: 'default',
  source: 'mic',
  sequence,
  capturedAt: new Date(Date.UTC(2026, 6, 10, 14, 0, sec)).toISOString(),
  contentType: 'text/plain',
  encoding: 'utf8',
  data,
})
const window = () => [chunk(1, 0, 'we should ship Thursday'), chunk(2, 4, 'agreed, Thursday it is')]

interface Rig {
  dir: string
  store: WorkspaceRegistry
  voice: VoiceDocuments
  docs: DistillDocuments
  guardDocs: GuardDocuments
  guardHolds: GuardHoldStore
  fabric: FabricDocuments
}

const setup = async (): Promise<Rig> => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-gate-seam-'))
  const store = new WorkspaceRegistry(dir)
  const voice = new VoiceDocuments(store)
  voice.ensureDefaults()
  const docs = new DistillDocuments(store)
  docs.ensureDefaults()
  const guardDocs = new GuardDocuments(store)
  guardDocs.ensureDefaults()
  const guardHolds = new GuardHoldStore(store)
  const fabric = new FabricDocuments(store)
  return { dir, store, voice, docs, guardDocs, guardHolds, fabric }
}
const teardown = async (rig: Rig): Promise<void> => {
  rig.store.close()
  await rm(rig.dir, { recursive: true, force: true })
}

const saveFabric = (rig: Rig, over: Partial<Fabric['slots']>): void => {
  rig.fabric.save({ slots: { ...defaultFabric().slots, ...over } })
}

// ── #64 egress CONSENT at the seam ──────────────────────────────────────────────────────────────────

test('seam: a LOCAL hop is neither consent-filtered nor guarded — no egress ⇒ no filter', async () => {
  const rig = await setup()
  const restore = installEgressRewrite()
  const llm = await startChat(llmReply)
  const guard = await startChat(() => '{"flagged":[]}')
  try {
    // A loopback llm endpoint (reach: local) + a configured guard + consent allowed (defaults).
    saveFabric(rig, {
      llm: [{ kind: 'http', name: 'llm.local', url: `http://127.0.0.1:${llm.port}`, api: 'openai-compat' }],
      guard: [{ kind: 'http', name: 'guard.local', url: `http://127.0.0.1:${guard.port}`, api: 'openai-compat' }],
    })
    const distiller = new Distiller({ ...rig, guardEnabled: () => true })
    const produced = await distiller.distillChunks(window(), { extractMoments: true, extractEntities: true })

    assert.equal(produced.length, 1)
    assert.equal(llm.hits(), 3, 'summary + moments + entities all answered by the local endpoint')
    assert.equal(guard.hits(), 0, 'the guard never runs on a local hop (reach !== egress)')
    // The recorded decision is an allowed local reach; no guard verdict is stamped.
    assert.equal(produced[0]!.provenance.egress?.reach, 'local')
    assert.equal(produced[0]!.provenance.guard, undefined)
  } finally {
    await stopChat(llm)
    await stopChat(guard)
    restore()
    await teardown(rig)
  }
})

test('seam: a DENYING mode holds egress before any byte leaves — the egress endpoint is never contacted', async () => {
  const rig = await setup()
  const restore = installEgressRewrite()
  const egress = await startChat(llmReply)
  try {
    // Mode denies egress (layer 3); the ONLY llm endpoint is egress-classified ⇒ the summary call has
    // nowhere honest to go. It must FAIL, not silently leave.
    rig.docs.saveMode({ ...rig.docs.mode(), egress: { deny: true } })
    saveFabric(rig, { llm: [{ kind: 'http', name: 'llm.hosted', url: `http://llm.egress.test:${egress.port}`, api: 'openai-compat' }] })
    const distiller = new Distiller({ ...rig })

    await assert.rejects(
      () => distiller.distillChunks(window(), { extractMoments: true, extractEntities: true }),
      /no llm endpoint answered|egress denied/i,
      'the pass fails closed — an egress-denied slot yields no answer',
    )
    assert.equal(egress.hits(), 0, 'the egress endpoint was skipped before any request left the machine')
    assert.deepEqual(rig.store.listDistillates('default'), [], 'nothing persisted')
  } finally {
    await stopChat(egress)
    restore()
    await teardown(rig)
  }
})

test('seam: consent rides ALL THREE calls — an egress-first slot gets ZERO hits across summary+moments+entities', async () => {
  const rig = await setup()
  const restore = installEgressRewrite()
  const egress = await startChat(llmReply) // listed FIRST — would answer every call IF consent were bypassed
  const local = await startChat(llmReply)
  try {
    rig.docs.saveMode({ ...rig.docs.mode(), egress: { deny: true } })
    saveFabric(rig, {
      llm: [
        { kind: 'http', name: 'llm.hosted', url: `http://llm.egress.test:${egress.port}`, api: 'openai-compat' },
        { kind: 'http', name: 'llm.local', url: `http://127.0.0.1:${local.port}`, api: 'openai-compat' },
      ],
    })
    const distiller = new Distiller({ ...rig })
    const produced = await distiller.distillChunks(window(), { extractMoments: true, extractEntities: true })

    assert.equal(produced.length, 1)
    // The regression sentinel: if ANY of the three calls dropped the egress wrapper, that call would have
    // been allowed to the egress-first endpoint (consent undefined ⇒ allowed) and this counter would be > 0.
    assert.equal(egress.hits(), 0, 'the egress-first endpoint was denied on every one of the 3 calls')
    assert.equal(local.hits(), 3, 'all three calls fell through to the local endpoint')
    const decision = produced[0]!.provenance.egress
    assert.equal(decision?.reach, 'local')
    assert.equal(decision?.allowed, false)
    assert.equal(decision?.decidedBy, 'mode', 'the deciding layer is recorded on provenance')
    assert.equal(rig.store.listMoments('default').length, 1)
    assert.equal(rig.store.listEntities('default').length, 1)
  } finally {
    await stopChat(egress)
    await stopChat(local)
    restore()
    await teardown(rig)
  }
})

test('seam: a never-egress PROMPT denies the window (layer 2) — decidedBy prompt, egress endpoint untouched', async () => {
  const rig = await setup()
  const restore = installEgressRewrite()
  const egress = await startChat(llmReply)
  const local = await startChat(llmReply)
  try {
    rig.docs.saveTemplate({ ...rig.docs.template(), neverEgress: true })
    saveFabric(rig, {
      llm: [
        { kind: 'http', name: 'llm.hosted', url: `http://llm.egress.test:${egress.port}`, api: 'openai-compat' },
        { kind: 'http', name: 'llm.local', url: `http://127.0.0.1:${local.port}`, api: 'openai-compat' },
      ],
    })
    const produced = await new Distiller({ ...rig }).distillChunks(window(), { extractMoments: true, extractEntities: true })

    assert.equal(produced.length, 1)
    assert.equal(egress.hits(), 0)
    assert.equal(local.hits(), 3)
    assert.equal(produced[0]!.provenance.egress?.decidedBy, 'prompt')
  } finally {
    await stopChat(egress)
    await stopChat(local)
    restore()
    await teardown(rig)
  }
})

// ── #63 egress GUARD at the seam (driven end-to-end through runEgressGuard) ───────────────────────────

test('seam: an ALLOWED egress hop runs the guard on EVERY call — clean verdict rides provenance, content left', async () => {
  const rig = await setup()
  const restore = installEgressRewrite()
  const egress = await startChat(llmReply)
  const guard = await startChat(() => '{"flagged":[]}')
  try {
    // Defaults allow egress (no deny, not never-egress); an egress-classified llm endpoint ⇒ the guard runs.
    saveFabric(rig, {
      llm: [{ kind: 'http', name: 'llm.hosted', url: `http://llm.egress.test:${egress.port}`, api: 'openai-compat' }],
      guard: [{ kind: 'http', name: 'guard.local', url: `http://127.0.0.1:${guard.port}`, api: 'openai-compat' }],
    })
    const distiller = new Distiller({ ...rig, guardEnabled: () => true })
    const produced = await distiller.distillChunks(window(), { extractMoments: true, extractEntities: true })

    assert.equal(produced.length, 1)
    assert.equal(egress.hits(), 3, 'all three calls actually left to the egress endpoint after the guard cleared them')
    assert.equal(guard.hits(), 3, 'the guard classified the outbound content on EVERY egress call (summary+moments+entities)')
    assert.equal(produced[0]!.provenance.egress?.reach, 'egress', 'content genuinely left the machine')
    assert.equal(produced[0]!.provenance.guard?.outcome, 'clean')
    assert.equal(produced[0]!.provenance.guard?.guarded, true)
  } finally {
    await stopChat(egress)
    await stopChat(guard)
    restore()
    await teardown(rig)
  }
})

test('seam: redact-and-continue masks flagged spans and proceeds — a redacted verdict rides provenance', async () => {
  const rig = await setup()
  const restore = installEgressRewrite()
  const egress = await startChat(llmReply)
  const guard = await startChat(() => '{"flagged":[{"start":0,"length":4,"kind":"secret"}]}')
  try {
    saveFabric(rig, {
      llm: [{ kind: 'http', name: 'llm.hosted', url: `http://llm.egress.test:${egress.port}`, api: 'openai-compat' }],
      guard: [{ kind: 'http', name: 'guard.local', url: `http://127.0.0.1:${guard.port}`, api: 'openai-compat' }],
    })
    const distiller = new Distiller({ ...rig, guardEnabled: () => true })
    const produced = await distiller.distillChunks(window())

    assert.equal(produced.length, 1, 'redact-and-continue still produces a distillate')
    const verdict = produced[0]!.provenance.guard
    assert.equal(verdict?.outcome, 'redacted')
    assert.ok((verdict?.maskedSpanCount ?? 0) >= 1)
    assert.equal(egress.hits(), 1, 'the (redacted) content still left to the egress endpoint')
  } finally {
    await stopChat(egress)
    await stopChat(guard)
    restore()
    await teardown(rig)
  }
})

test('seam: hold-and-surface HOLDS the hop — no distillate, a durable GuardHold is recorded and surfaced, release/deny behaves', async () => {
  const rig = await setup()
  const restore = installEgressRewrite()
  const egress = await startChat(llmReply)
  const guard = await startChat(() => '{"flagged":[{"start":0,"length":4,"kind":"card-number"}]}')
  try {
    rig.guardDocs.savePolicy({ id: 'guard-policy', version: 2, behavior: 'hold-and-surface', acknowledgeUnguardedEgress: false })
    saveFabric(rig, {
      llm: [{ kind: 'http', name: 'llm.hosted', url: `http://llm.egress.test:${egress.port}`, api: 'openai-compat' }],
      guard: [{ kind: 'http', name: 'guard.local', url: `http://127.0.0.1:${guard.port}`, api: 'openai-compat' }],
    })
    const published: GuardHold[] = []
    const distiller = new Distiller({ ...rig, guardEnabled: () => true, publishHold: (h) => void published.push(h) })
    const produced = await distiller.distillChunks(window(), { extractMoments: true, extractEntities: true })

    assert.equal(produced.length, 0, 'a held window produces no distillate (fail closed)')
    assert.equal(egress.hits(), 0, 'nothing left the machine — the hop was suspended before the egress call')
    assert.deepEqual(rig.store.listDistillates('default'), [])

    const holds = rig.guardHolds.list('default')
    assert.equal(holds.length, 1, 'the held hop is a durable audit record')
    assert.equal(holds[0]!.status, 'held')
    assert.equal(holds[0]!.stage, 'distill')
    assert.equal(holds[0]!.verdict.outcome, 'held')
    assert.deepEqual(holds[0]!.verdict.spans, [{ start: 0, length: 4, kind: 'card-number' }], 'span descriptors ride the verdict, never the raw value')
    assert.equal(published.length, 1, 'the hold was surfaced (published)')

    // Release/deny behaves and is idempotent.
    const released = rig.guardHolds.resolve('default', holds[0]!.id, 'released', '2026-07-10T15:00:00Z')
    assert.equal(released?.status, 'released')
    const again = rig.guardHolds.resolve('default', holds[0]!.id, 'denied', '2026-07-10T15:01:00Z')
    assert.equal(again?.status, 'released', 'resolving an already-resolved hold is a no-op')
  } finally {
    await stopChat(egress)
    await stopChat(guard)
    restore()
    await teardown(rig)
  }
})

test('seam: a fail-closed EMPTY guard slot in strict mode HOLDS egress (never silently unguarded)', async () => {
  const rig = await setup()
  const restore = installEgressRewrite()
  const egress = await startChat(llmReply)
  try {
    rig.guardDocs.savePolicy({ id: 'guard-policy', version: 2, behavior: 'hold-and-surface', acknowledgeUnguardedEgress: false })
    // Egress allowed + an egress endpoint, but NO guard endpoint configured — strict mode must hold.
    saveFabric(rig, {
      llm: [{ kind: 'http', name: 'llm.hosted', url: `http://llm.egress.test:${egress.port}`, api: 'openai-compat' }],
      guard: [],
    })
    const distiller = new Distiller({ ...rig, guardEnabled: () => true })
    const produced = await distiller.distillChunks(window())

    assert.equal(produced.length, 0)
    assert.equal(egress.hits(), 0, 'no guard configured + strict ⇒ egress held, nothing left')
    const holds = rig.guardHolds.list('default')
    assert.equal(holds.length, 1)
    assert.equal(holds[0]!.verdict.guarded, false, 'the hold is honest: no guard ran')
  } finally {
    await stopChat(egress)
    restore()
    await teardown(rig)
  }
})

// ── the LEDGER renders what the seam produced (current ledger — #65 with #63/#64 columns) ─────────────

test('seam → ledger: the produced egress + guard provenance and the held hop render on the audit ledger', async () => {
  const rig = await setup()
  const restore = installEgressRewrite()
  const egress = await startChat(llmReply)
  const cleanGuard = await startChat(() => '{"flagged":[]}')
  try {
    // Pass 1: a CLEAN egress pass (produces a distillate carrying reach:'egress' + a clean guard verdict).
    saveFabric(rig, {
      llm: [{ kind: 'http', name: 'llm.hosted', url: `http://llm.egress.test:${egress.port}`, api: 'openai-compat' }],
      guard: [{ kind: 'http', name: 'guard.local', url: `http://127.0.0.1:${cleanGuard.port}`, api: 'openai-compat' }],
    })
    await new Distiller({ ...rig, guardEnabled: () => true }).distillChunks(window())

    // Pass 2: a HELD pass (strict, empty guard slot) — records a GuardHold, no distillate.
    rig.guardDocs.savePolicy({ id: 'guard-policy', version: 2, behavior: 'hold-and-surface', acknowledgeUnguardedEgress: false })
    saveFabric(rig, {
      llm: [{ kind: 'http', name: 'llm.hosted', url: `http://llm.egress.test:${egress.port}`, api: 'openai-compat' }],
      guard: [],
    })
    await new Distiller({ ...rig, guardEnabled: () => true }).distillChunks([chunk(3, 30, 'a later, held window')])

    const passes = buildLedger(rig.store.listDistillates('default'), rig.store.listOcrResults('default'))
    const held = rig.guardHolds.list('default')
    assert.equal(passes.length, 1, 'the clean pass is a rendered pass; the held one produced no distillate')
    assert.equal(held.length, 1)

    const html = renderLedger({ ledger: passes, guardHolds: held } as unknown as SetupData)
    assert.match(html, /ldg-egress[^>]*>egress</, 'the egress column shows the content actually left')
    assert.match(html, /ldg-guard-clean[^>]*>clean</, 'the guard column shows the recorded clean verdict')
    assert.match(html, /ldg-guard-held">held/, 'the held block surfaces the suspended hop')
    assert.match(html, /data-guard-action="release"/, 'the held hop carries a release affordance')
    assert.match(html, /data-guard-action="deny"/, 'the held hop carries a deny affordance')
  } finally {
    await stopChat(egress)
    await stopChat(cleanGuard)
    restore()
    await teardown(rig)
  }
})
