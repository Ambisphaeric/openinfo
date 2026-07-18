import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Distillate, PromptTemplate, Session, SummaryLevel } from '@openinfo/contracts'
import { WorkspaceRegistry } from '../store/index.js'
import { materializeSummaries, type Summarizer } from './produce-summaries.js'

/**
 * #246 SOVEREIGNTY PROOF — a user correction on a summary OUTRANKS the machine revision on read AND SURVIVES
 * re-derivation: correct → re-run the producer (even when it appends a NEW machine revision for the same
 * window) → the read still returns the USER text, never the model's. This is the acceptance bar. It also
 * pins the append-only invariant (the machine chain is retained, retrievable with includeSuperseded, never
 * deleted) and the honesty invariant (a correction carries NO model-invoke provenance — human prose is never
 * attributed to a model), and confirms a correction is a purely LOCAL store write (no network, no egress).
 */

const DIALS = { tone: 5, warmth: 5, wit: 5, charm: 5, specificity: 5, brevity: 5 }
const T0 = Date.parse('2026-07-16T13:00:00.000Z')

const startSession = (store: WorkspaceRegistry, sessionId: string): Session => {
  const session: Session = { id: sessionId, workspaceId: 'default', modeId: 'mode-meeting', startedAt: '2026-07-16T13:00:00.000Z', attribution: { confidence: 1, evidence: [] } }
  store.saveSession(session)
  return session
}
const distillate = (sessionId: string, sec: number, text: string): Distillate => {
  const at = new Date(T0 + sec * 1000).toISOString()
  return { id: `dist-${sec}`, sessionId, workspaceId: 'default', windowStart: at, windowEnd: at, sourceChunks: [`c-${sec}`], text, voice: { scope: 'global', dials: DIALS }, provenance: { slot: 'llm', endpoint: 'fake' }, schemaVersion: 1, createdAt: at }
}
const rollingTemplate: PromptTemplate = {
  id: 'tpl-summary-rolling', name: 'r', kind: 'summary', slot: 'llm', builtin: true,
  summary: { level: 'rolling', windowMs: 60_000, maxChildren: 6, maxEvidence: 0 },
  body: 'Summarize:\n{{children}}\n\nRolling:',
}
const oneTemplate = (l: SummaryLevel): PromptTemplate | undefined => (l === 'rolling' ? rollingTemplate : undefined)
const echoSummarizer: Summarizer = async (req) => ({ text: `[model] ${req.childTexts.join(' | ')}`, slot: 'llm', endpoint: 'fake-llm', model: 'fake' })
const runProducer = (store: WorkspaceRegistry, sessionId: string) =>
  materializeSummaries(
    { store, summaryTemplate: oneTemplate, summarize: echoSummarizer, now: () => new Date('2026-07-16T13:02:00.000Z') },
    { workspaceId: 'default', sessionId, trigger: 'drain', levels: ['rolling'] },
  )

test('#246: a user correction outranks the machine summary on read, and SURVIVES re-derivation (even a new machine revision)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-sum-correct-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const s = startSession(store, 'ses-1')
    store.saveDistillate(distillate(s.id, 5, 'we discussed the release'))
    store.saveDistillate(distillate(s.id, 25, 'and assigned the migration'))

    // 1) The producer materializes the machine (model-proposal) rolling summary.
    const first = await runProducer(store, s.id)
    assert.equal(first.created.length, 1)
    const machine = store.listSummaries('default', { sessionId: s.id, level: 'rolling' })[0]!
    assert.equal(machine.source, undefined, 'the machine summary is model-derived (no user source)')
    assert.equal(machine.proposal, true)

    // 2) The user corrects it — a sovereign append-only revision.
    const correction = store.correctSummary({ workspaceId: 'default', summaryId: machine.id, text: 'the migration ships Thursday — decided', by: 'me' })
    assert.equal(correction.source, 'user')
    assert.equal(correction.proposal, false)
    assert.equal(correction.corrects, machine.id)
    assert.equal(correction.confidence, 1)
    assert.equal(correction.provenance.endpoint, undefined, 'a correction carries NO model-invoke provenance — human prose is never attributed to a model')
    assert.ok(correction.correction?.at && correction.correction.by === 'me')

    // 3) Read sovereignty: the LIVE head is the user text, not the model proposal.
    const afterCorrect = store.listSummaries('default', { sessionId: s.id, level: 'rolling' })
    assert.equal(afterCorrect.length, 1, 'one live head')
    assert.equal(afterCorrect[0]!.source, 'user')
    assert.equal(afterCorrect[0]!.text, 'the migration ships Thursday — decided')

    // 4) Append-only: the machine revision is RETAINED, retrievable with includeSuperseded (never deleted).
    const all = store.listSummaries('default', { sessionId: s.id, level: 'rolling', includeSuperseded: true })
    assert.ok(all.some((x) => x.id === machine.id && x.source === undefined), 'the machine summary is retained for audit')
    assert.ok(all.some((x) => x.source === 'user'), 'the correction is retained')

    // 5) SURVIVES RE-DERIVATION — idempotent rebuild (same inputs): the user text still wins.
    await runProducer(store, s.id)
    const afterRerun = store.listSummaries('default', { sessionId: s.id, level: 'rolling' })
    assert.equal(afterRerun.length, 1)
    assert.equal(afterRerun[0]!.text, 'the migration ships Thursday — decided', 'idempotent re-run cannot defeat the correction')

    // 6) SURVIVES RE-DERIVATION — a CHANGED child set forces a NEW machine revision for the SAME window; the
    //    correction (keyed by the stable window/level identity) still outranks the freshly-derived revision.
    store.saveDistillate(distillate(s.id, 45, 'and set the go/no-go for Wednesday'))
    const regen = await runProducer(store, s.id)
    assert.ok(regen.created.length >= 1, 'the changed child set appended a new machine revision')
    const afterRegen = store.listSummaries('default', { sessionId: s.id, level: 'rolling' })
    assert.equal(afterRegen.length, 1, 'still exactly one live head')
    assert.equal(afterRegen[0]!.source, 'user', 'a NEWLY re-derived machine revision cannot defeat the sovereign correction')
    assert.equal(afterRegen[0]!.text, 'the migration ships Thursday — decided')
    // The new machine revision exists in history (append-only) but sits behind the sovereign head on read.
    const regenHistory = store.listSummaries('default', { sessionId: s.id, level: 'rolling', includeSuperseded: true })
    assert.ok(regenHistory.filter((x) => x.source === undefined).length >= 2, 'the re-derived machine revision is retained behind the correction')
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('#246: correcting a DEGRADED summary is refused (nothing to correct until a model connects)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-sum-correct-deg-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const s = startSession(store, 'ses-2')
    store.saveDistillate(distillate(s.id, 5, 'we discussed the release'))
    // A down summarizer degrades honestly (no prose).
    await materializeSummaries(
      { store, summaryTemplate: oneTemplate, summarize: async () => ({ degraded: 'no summarizer endpoint' }), now: () => new Date('2026-07-16T13:02:00.000Z') },
      { workspaceId: 'default', sessionId: s.id, trigger: 'drain', levels: ['rolling'] },
    )
    const degraded = store.listSummaries('default', { sessionId: s.id, level: 'rolling' })[0]!
    assert.equal(degraded.text, undefined)
    assert.throws(() => store.correctSummary({ workspaceId: 'default', summaryId: degraded.id, text: 'anything' }), /no prose to correct/)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
