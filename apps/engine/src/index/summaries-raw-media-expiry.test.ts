import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Distillate, Session, Summary } from '@openinfo/contracts'
import { WorkspaceRegistry } from '../store/index.js'
import { DistillDocuments } from '../distill/index.js'
import { materializeSummaries, type Summarizer } from './produce-summaries.js'
import { walkSummaryTrace } from './summaries-trace.js'

/**
 * #177 slice 2 — RAW-MEDIA EXPIRY does not break the derivation path (the acceptance criterion). A summary
 * references only durable derived records; those name the RAW capture chunks (audio/frames) they came from,
 * and raw capture is TRANSIENT — never persisted. So even with the raw evidence gone, the summary, its
 * children refs, and provenance stay queryable and the trace stays WALKABLE: every node resolves to a present
 * durable record or an HONEST `expired` leaf — never a crash, never fabricated content. A dangling durable
 * ref (a pruned record) is reported `expired` too, not a break.
 */

const WS = 'ws-expiry'
const SES = 'ses-expiry'
const DIALS = { tone: 5, warmth: 5, wit: 5, charm: 5, specificity: 5, brevity: 5 }
const deterministic: Summarizer = async (req) => ({ text: `${req.level}: ${req.childTexts.join(' / ')}`, slot: 'llm', endpoint: 'fixture', model: 'fixture' })

test('#177 raw-media expiry: the rolling summary’s trace stays walkable — durable records present, the expired raw capture honestly marked', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-sum-expiry-'))
  const store = new WorkspaceRegistry(dir)
  const docs = new DistillDocuments(store)
  docs.ensureDefaults()
  try {
    const session: Session = { id: SES, workspaceId: WS, modeId: 'mode-meeting', startedAt: '2026-07-16T13:00:00.000Z', attribution: { confidence: 1, evidence: [] } }
    store.saveSession(session)
    // A distillate naming a raw capture chunk (`chunk-raw-0`) that is never persisted — raw capture is transient.
    const at = '2026-07-16T13:00:05.000Z'
    const distillate: Distillate = { id: 'dist-0', sessionId: SES, workspaceId: WS, windowStart: at, windowEnd: at, sourceChunks: ['chunk-raw-0'], text: 'we agreed to ship Thursday', voice: { scope: 'global', dials: DIALS }, provenance: { slot: 'llm', endpoint: 'fake' }, schemaVersion: 1, createdAt: at }
    store.saveDistillate(distillate)

    await materializeSummaries({ store, summaryTemplate: (l: Summary['level']) => docs.summaryTemplate(l), summarize: deterministic, now: () => new Date('2026-07-16T13:02:00.000Z') }, { workspaceId: WS, sessionId: SES, trigger: 'session-end', levels: ['rolling'] })

    const rolling = store.listSummaries(WS, { sessionId: SES, level: 'rolling' })[0]!
    // The summary + its children refs + provenance are intact even though raw capture is gone.
    assert.ok(rolling.text !== undefined, 'the summary is queryable')
    assert.equal(rolling.children[0]!.record, 'distillate')
    assert.ok(rolling.provenance.templateId.length > 0, 'provenance survives')

    const trace = walkSummaryTrace(store, WS, rolling)
    const distNode = trace.nodes.find((n) => n.ref.record === 'distillate')!
    assert.equal(distNode.status, 'present', 'the durable distillate child still resolves')
    // The raw layer beneath it — the capture chunk — is honestly reported EXPIRED (not retained), not a crash.
    const rawLeaf = distNode.children!.find((c) => c.ref.record === 'capture-chunk')!
    assert.equal(rawLeaf.ref.id, 'chunk-raw-0')
    assert.equal(rawLeaf.status, 'expired')
    assert.match(rawLeaf.reason!, /not retained/i, 'the missing raw source has an honest human class')
    assert.equal(trace.hasExpiredSource, true, 'the expired raw source is disclosed, never hidden')
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('#177 raw-media expiry: a DANGLING durable ref (a pruned child) is reported expired — the walk never throws or fabricates', async () => {
  const summary: Summary = {
    id: 'sum-dangling',
    workspaceId: WS,
    sessionId: SES,
    level: 'five-minute',
    windowStart: '2026-07-16T13:00:00.000Z',
    windowEnd: '2026-07-16T13:05:00.000Z',
    children: [{ record: 'summary', id: 'sum-gone', at: '2026-07-16T13:00:00.000Z', role: 'child', level: 'rolling' }],
    bound: { childrenAvailable: 1, childrenConsumed: 1, evidenceAvailable: 0, evidenceConsumed: 0 },
    text: 'a summary whose child was pruned',
    proposal: true,
    confidence: 0.4,
    provenance: { builder: 'bounded-hierarchical-summary', windowMs: 300_000, childLevel: 'rolling', templateId: 'tpl-summary-five-minute' },
    revision: 1,
    schemaVersion: 1,
    createdAt: '2026-07-16T13:05:00.000Z',
  }
  // No store record exists for `sum-gone` — resolving it must be honest, not a throw.
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-sum-dangling-'))
  const store = new WorkspaceRegistry(dir)
  try {
    // Persist the parent so the workspace exists; its child `sum-gone` is deliberately absent (pruned).
    store.saveSummary(summary)
    const trace = walkSummaryTrace(store, WS, summary)
    assert.equal(trace.nodes.length, 1)
    assert.equal(trace.nodes[0]!.status, 'expired', 'a dangling child ref resolves to an honest expired node')
    assert.match(trace.nodes[0]!.reason!, /no longer retained/i)
    assert.equal(trace.hasExpiredSource, true)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
