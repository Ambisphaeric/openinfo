import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk, GuardHold } from '@openinfo/contracts'
import { FabricDocuments } from '../fabric/index.js'
import { GuardHeldError } from '../fabric/index.js'
import { WorkspaceRegistry } from '../store/index.js'
import { VoiceDocuments } from '../voice/index.js'
import { GuardDocuments, GuardHoldStore } from '../guard/index.js'
import { Distiller, type LlmInvoke } from './distiller.js'
import { DistillDocuments } from './documents.js'

/**
 * Distiller-level guard behavior (#63): when an egress hop HOLDS (GuardHeldError thrown out of the invoke),
 * the distiller records a durable GuardHold audit record (verdict with span descriptors, never the raw
 * value), publishes it, and SKIPS the window — no distillate is produced (fail closed, nothing left). When
 * the invoke returns a REDACTED verdict, it rides onto the distillate's provenance. The guard config is
 * built from the policy doc + the guard.egress flag (here injected via guardEnabled).
 */

const speech = (sequence: number, data: string): CaptureChunk => ({
  id: `sp-${sequence}`,
  sessionId: 'ses-g',
  workspaceId: 'default',
  source: 'mic',
  sequence,
  capturedAt: new Date(Date.UTC(2026, 6, 10, 14, 0, sequence)).toISOString(),
  contentType: 'text/plain',
  encoding: 'utf8',
  data,
})

const setup = async (): Promise<{ dir: string; store: WorkspaceRegistry; deps: Omit<Parameters<typeof makeDistiller>[0], 'invoke' | 'holds'> }> => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-distill-guard-'))
  const store = new WorkspaceRegistry(dir)
  const voice = new VoiceDocuments(store)
  voice.ensureDefaults()
  const docs = new DistillDocuments(store)
  docs.ensureDefaults()
  const guardDocs = new GuardDocuments(store)
  guardDocs.ensureDefaults()
  const guardHolds = new GuardHoldStore(store)
  const fabric = new FabricDocuments(store)
  return { dir, store, deps: { store, voice, docs, guardDocs, guardHolds, fabric } }
}
const makeDistiller = (deps: { store: WorkspaceRegistry; voice: VoiceDocuments; docs: DistillDocuments; guardDocs: GuardDocuments; guardHolds: GuardHoldStore; fabric: FabricDocuments; invoke: LlmInvoke; holds?: GuardHold[] }): Distiller =>
  new Distiller({
    store: deps.store,
    voice: deps.voice,
    docs: deps.docs,
    fabric: deps.fabric,
    guardDocs: deps.guardDocs,
    guardHolds: deps.guardHolds,
    guardEnabled: () => true,
    invoke: deps.invoke,
    ...(deps.holds ? { publishHold: (h) => void deps.holds!.push(h) } : {}),
  })

test('a HELD egress hop records a GuardHold audit record and produces NO distillate (fail closed)', async () => {
  const { dir, store, deps } = await setup()
  try {
    // Strict policy so a flagged hop holds.
    deps.guardDocs.savePolicy({ id: 'guard-policy', version: 2, behavior: 'hold-and-surface', acknowledgeUnguardedEgress: false })
    const published: GuardHold[] = []
    const invoke: LlmInvoke = () =>
      Promise.reject(
        new GuardHeldError(
          { behavior: 'hold-and-surface', outcome: 'held', guarded: true, maskedSpanCount: 1, spans: [{ kind: 'card-number', start: 0, length: 16 }], guardEndpoint: 'guard-local', reason: 'the egress guard flagged 1 span(s); strict mode suspended the hop for review' },
          { endpoint: 'hosted', url: 'https://api.example.com' },
        ),
      )
    const distiller = makeDistiller({ ...deps, invoke, holds: published })

    const produced = await distiller.distillChunks([speech(1, 'pay card 4111111111111111')])
    assert.equal(produced.length, 0, 'no distillate for a held window (nothing left the machine)')
    assert.deepEqual(store.listDistillates('default'), [], 'nothing persisted')

    const holds = deps.guardHolds.list('default')
    assert.equal(holds.length, 1, 'the held hop is recorded as a durable audit record')
    assert.equal(holds[0]!.status, 'held')
    assert.equal(holds[0]!.stage, 'distill')
    assert.equal(holds[0]!.verdict.outcome, 'held')
    assert.deepEqual(holds[0]!.verdict.spans, [{ kind: 'card-number', start: 0, length: 16 }])
    assert.equal(published.length, 1, 'the hold was published (surfaced)')
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('a REDACTED verdict rides onto the distillate provenance (audit trail)', async () => {
  const { dir, store, deps } = await setup()
  try {
    const invoke: LlmInvoke = () =>
      Promise.resolve({
        text: 'summary with a [redacted:card-number]',
        endpoint: 'hosted',
        slot: 'llm',
        guard: { behavior: 'redact-and-continue', outcome: 'redacted', guarded: true, maskedSpanCount: 1, spans: [{ kind: 'card-number', start: 0, length: 16 }], guardEndpoint: 'guard-local', reason: 'the egress guard masked 1 flagged span(s) before the content left the machine' },
      })
    const distiller = makeDistiller({ ...deps, invoke })

    const produced = await distiller.distillChunks([speech(1, 'pay card 4111111111111111')])
    assert.equal(produced.length, 1)
    const guard = produced[0]!.provenance.guard
    assert.ok(guard, 'the guard verdict is stamped on provenance')
    assert.equal(guard.outcome, 'redacted')
    assert.equal(guard.maskedSpanCount, 1)
    // The stored distillate carries it too (the ledger reads this).
    assert.equal(store.listDistillates('default')[0]!.provenance.guard?.outcome, 'redacted')
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('guard OFF (guardEnabled false) skips the guard entirely — pre-#63 behavior', async () => {
  const { dir, store, deps } = await setup()
  try {
    let sawGuardOpt = false
    const invoke: LlmInvoke = (_messages, opts) => {
      sawGuardOpt = (opts as { guard?: unknown }).guard !== undefined
      return Promise.resolve({ text: 'summary', endpoint: 'loc', slot: 'llm' })
    }
    const distiller = new Distiller({ store: deps.store, voice: deps.voice, docs: deps.docs, fabric: deps.fabric, guardDocs: deps.guardDocs, guardHolds: deps.guardHolds, guardEnabled: () => false, invoke })
    const produced = await distiller.distillChunks([speech(1, 'hello')])
    assert.equal(produced.length, 1)
    assert.equal(sawGuardOpt, false, 'no guard option is threaded when the flag is off')
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('#116: a recorded hold carries the window pass spanId + the held chunk ids (ids only, never content)', async () => {
  const { dir, store, deps } = await setup()
  try {
    deps.guardDocs.savePolicy({ id: 'guard-policy', version: 2, behavior: 'hold-and-surface', acknowledgeUnguardedEgress: false })
    const invoke: LlmInvoke = () =>
      Promise.reject(
        new GuardHeldError(
          { behavior: 'hold-and-surface', outcome: 'held', guarded: true, maskedSpanCount: 1, spans: [{ kind: 'card-number', start: 0, length: 16 }], guardEndpoint: 'guard-local', reason: 'the egress guard flagged 1 span(s); strict mode suspended the hop for review' },
          { endpoint: 'hosted', url: 'https://api.example.com' },
        ),
      )
    const distiller = makeDistiller({ ...deps, invoke })
    await distiller.distillChunks([speech(1, 'pay card 4111111111111111')])
    const hold = deps.guardHolds.list('default')[0]!
    assert.ok(hold.spanId !== undefined && hold.spanId.length > 0, 'the hold carries the suspended pass correlation id')
    assert.deepEqual(hold.sourceChunks, ['sp-1'], 'the hold names the held window chunk IDS — the trace parent link')
    assert.ok(!JSON.stringify(hold).includes('4111111111111111'), 'the raw flagged content is never retained')
    void store
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
