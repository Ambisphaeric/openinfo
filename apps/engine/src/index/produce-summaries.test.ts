import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Distillate, PromptTemplate, Session, SummaryLevel } from '@openinfo/contracts'
import { WorkspaceRegistry } from '../store/index.js'
import { materializeSummaries, SummaryBuildLog, type Summarizer } from './produce-summaries.js'

/**
 * The LIVE producer seam (#177). Drives the REAL store: it materializes summaries from stored distillates
 * WITHOUT the on-demand route, BOUNDS its inputs, is idempotent on a converged rebuild, isolates workspaces,
 * degrades HONESTLY when the model is unavailable (no fabricated prose), upgrades a degraded summary in
 * place when the model returns, and CONTAINS a failure (never throws; records the reason on the log).
 */

const DIALS = { tone: 5, warmth: 5, wit: 5, charm: 5, specificity: 5, brevity: 5 }
const T0 = Date.parse('2026-07-16T13:00:00.000Z')

const startSession = (store: WorkspaceRegistry, workspaceId: string, id: string): Session => {
  const session: Session = { id, workspaceId, modeId: 'mode-meeting', startedAt: '2026-07-16T13:00:00.000Z', attribution: { confidence: 1, evidence: [] } }
  store.saveSession(session)
  return session
}

const distillate = (workspaceId: string, sessionId: string, sec: number, text: string): Distillate => {
  const at = new Date(T0 + sec * 1000).toISOString()
  return {
    id: `dist-${sec}`, sessionId, workspaceId, windowStart: at, windowEnd: at, sourceChunks: [`c-${sec}`],
    text, voice: { scope: 'global', dials: DIALS }, provenance: { slot: 'llm', endpoint: 'fake' }, schemaVersion: 1, createdAt: at,
  }
}

const rollingTemplate = (overrides: Partial<NonNullable<PromptTemplate['summary']>> = {}): PromptTemplate => ({
  id: 'tpl-summary-rolling', name: 'r', kind: 'summary', slot: 'llm', builtin: true,
  summary: { level: 'rolling', windowMs: 60_000, maxChildren: 6, maxEvidence: 0, ...overrides },
  body: 'Summarize:\n{{children}}\n\nRolling:',
})
const oneTemplate = (level: SummaryLevel, t: PromptTemplate) => (l: SummaryLevel): PromptTemplate | undefined => (l === level ? t : undefined)

/** A fake summarizer that echoes its BOUNDED child texts — so a test can see exactly what reached the model. */
const echoSummarizer: Summarizer = async (req) => ({ text: `[${req.level}] ${req.childTexts.join(' | ')}`, slot: 'llm', endpoint: 'fake-llm', model: 'fake' })
const downSummarizer: Summarizer = async () => ({ degraded: 'no summarizer endpoint (fabric llm slot is empty)' })

test('#177 live producer: materializes a rolling summary from stored distillates — no on-demand route', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-sum-'))
  const store = new WorkspaceRegistry(dir)
  const log = new SummaryBuildLog()
  try {
    const s = startSession(store, 'default', 'ses-1')
    store.saveDistillate(distillate('default', s.id, 5, 'we discussed the release'))
    store.saveDistillate(distillate('default', s.id, 25, 'and assigned the migration'))

    const out = await materializeSummaries(
      { store, summaryTemplate: oneTemplate('rolling', rollingTemplate()), summarize: echoSummarizer, log, now: () => new Date('2026-07-16T13:02:00.000Z') },
      { workspaceId: 'default', sessionId: s.id, trigger: 'drain', levels: ['rolling'] },
    )
    assert.equal(out.error, undefined)
    assert.equal(out.created.length, 1, 'one 60s window materialized')
    const sum = out.created[0]!
    assert.equal(sum.level, 'rolling')
    assert.equal(sum.proposal, true, 'the prose is a model proposal')
    assert.equal(sum.text, '[rolling] we discussed the release | and assigned the migration')
    assert.equal(sum.children.length, 2, 'both distillates are referenced (refs, not copied)')
    assert.ok(sum.children.every((c) => c.record === 'distillate' && c.role === 'child'))

    // Durably queryable with NO POST /summaries/build ever called.
    const stored = store.listSummaries('default', { sessionId: s.id, level: 'rolling' })
    assert.deepEqual(stored.map((x) => x.id), [sum.id])

    // Idempotent: a converged rebuild appends nothing.
    const again = await materializeSummaries(
      { store, summaryTemplate: oneTemplate('rolling', rollingTemplate()), summarize: echoSummarizer, log, now: () => new Date('2027-01-01T00:00:00.000Z') },
      { workspaceId: 'default', sessionId: s.id, trigger: 'drain', levels: ['rolling'] },
    )
    assert.equal(again.created.length, 0, 'nothing changed ⇒ nothing appended')
    assert.equal(again.unchanged, 1)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('#177 live producer: the input is BOUNDED — an over-long session feeds only maxChildren to the model', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-sum-bound-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const s = startSession(store, 'default', 'ses-b')
    for (let i = 0; i < 10; i++) store.saveDistillate(distillate('default', s.id, i, `line ${i}`)) // 10 in one 60s window

    let seenChildTexts = 0
    const spy: Summarizer = async (req) => { seenChildTexts = req.childTexts.length; return echoSummarizer(req) }
    const out = await materializeSummaries(
      { store, summaryTemplate: oneTemplate('rolling', rollingTemplate({ maxChildren: 4 })), summarize: spy, now: () => new Date('2026-07-16T13:02:00.000Z') },
      { workspaceId: 'default', sessionId: s.id, trigger: 'drain', levels: ['rolling'] },
    )
    assert.equal(seenChildTexts, 4, 'the summarizer never sees more than maxChildren — never unbounded raw history')
    assert.equal(out.created[0]!.bound.childrenAvailable, 10)
    assert.equal(out.created[0]!.bound.childrenConsumed, 4)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('#177 live producer: HONEST degraded state when the summarizer is unavailable — no fabricated prose, then upgrade in place', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-sum-degraded-'))
  const store = new WorkspaceRegistry(dir)
  const log = new SummaryBuildLog()
  try {
    const s = startSession(store, 'default', 'ses-d')
    store.saveDistillate(distillate('default', s.id, 5, 'the model is down but the structure is real'))

    // Model unavailable ⇒ the summary is persisted DEGRADED: no text, an explicit reason, refs intact.
    const down = await materializeSummaries(
      { store, summaryTemplate: oneTemplate('rolling', rollingTemplate()), summarize: downSummarizer, log, now: () => new Date('2026-07-16T13:02:00.000Z') },
      { workspaceId: 'default', sessionId: s.id, trigger: 'drain', levels: ['rolling'] },
    )
    assert.equal(down.degraded, 1)
    const degraded = down.created[0]!
    assert.equal(degraded.text, undefined, 'nothing is invented when the model is unavailable')
    assert.equal(degraded.degraded?.reason, 'no summarizer endpoint (fabric llm slot is empty)')
    assert.ok(degraded.children.length === 1, 'the derivation path is intact even when degraded')
    assert.equal(log.latestFor('default', s.id, 'rolling')!.degraded, 1)

    // A still-down retry is a TRUE no-op (never downgrades, never churns).
    const stillDown = await materializeSummaries(
      { store, summaryTemplate: oneTemplate('rolling', rollingTemplate()), summarize: downSummarizer, log, now: () => new Date('2026-07-16T13:03:00.000Z') },
      { workspaceId: 'default', sessionId: s.id, trigger: 'drain', levels: ['rolling'] },
    )
    assert.equal(stillDown.created.length, 0, 'a still-degraded retry writes nothing')
    assert.equal(store.listSummaries('default', { sessionId: s.id, level: 'rolling' }).length, 1)

    // Model returns ⇒ the degraded summary is UPGRADED IN PLACE: same id, prose filled, still one row.
    const up = await materializeSummaries(
      { store, summaryTemplate: oneTemplate('rolling', rollingTemplate()), summarize: echoSummarizer, log, now: () => new Date('2026-07-16T13:04:00.000Z') },
      { workspaceId: 'default', sessionId: s.id, trigger: 'drain', levels: ['rolling'] },
    )
    assert.equal(up.created.length, 1, 'the upgrade writes the filled-in summary')
    assert.equal(up.created[0]!.id, degraded.id, 'in place — same id, not a new revision')
    assert.equal(up.created[0]!.text, '[rolling] the model is down but the structure is real')
    const heads = store.listSummaries('default', { sessionId: s.id, level: 'rolling' })
    assert.equal(heads.length, 1, 'still exactly one summary for the window')
    assert.ok(heads[0]!.text !== undefined && heads[0]!.degraded === undefined, 'the stored head is now prose, no longer degraded')
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('#177 live producer: workspace isolation — a build reads and writes only its own workspace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-sum-iso-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const a = startSession(store, 'ws-a', 'ses-a')
    const b = startSession(store, 'ws-b', 'ses-b')
    store.saveDistillate(distillate('ws-a', a.id, 5, 'a only'))
    store.saveDistillate(distillate('ws-b', b.id, 5, 'b only'))
    await materializeSummaries(
      { store, summaryTemplate: oneTemplate('rolling', rollingTemplate()), summarize: echoSummarizer, now: () => new Date('2026-07-16T13:02:00.000Z') },
      { workspaceId: 'ws-a', sessionId: a.id, trigger: 'drain', levels: ['rolling'] },
    )
    assert.equal(store.listSummaries('ws-a', { level: 'rolling' }).length, 1, 'ws-a has its summary')
    assert.equal(store.listSummaries('ws-b', { level: 'rolling' }).length, 0, 'ws-b is untouched')
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('#177 live producer: a build failure is CONTAINED — never thrown, recorded on the log with its reason', async () => {
  const log = new SummaryBuildLog()
  const boom = 'disk read failed mid-build'
  const brokenStore = { listDistillates: () => { throw new Error(boom) } } as unknown as WorkspaceRegistry
  let threw = false
  let outcome
  try {
    outcome = await materializeSummaries(
      { store: brokenStore, summaryTemplate: oneTemplate('rolling', rollingTemplate()), summarize: echoSummarizer, log },
      { workspaceId: 'default', sessionId: 'ses-x', trigger: 'drain', levels: ['rolling'] },
    )
  } catch { threw = true }
  assert.equal(threw, false, 'materialize never throws — the drain/session-end path is never sunk by a summary build')
  assert.ok(outcome && outcome.error !== undefined && outcome.error.includes(boom), 'the true reason is returned')
  assert.deepEqual(outcome!.created, [], 'nothing is claimed built on failure')
  assert.equal(log.latestFor('default', 'ses-x', 'rolling')!.error, boom, 'recorded for the diagnostics last-update line')
})
