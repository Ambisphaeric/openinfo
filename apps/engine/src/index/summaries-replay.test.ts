import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Distillate, Session, Summary } from '@openinfo/contracts'
import { loadFixtureSync, createFixtureReplay } from '../../../../tools/fixtures/model.mjs'
import { WorkspaceRegistry } from '../store/index.js'
import { DistillDocuments } from '../distill/index.js'
import { materializeSummaries, type Summarizer } from './produce-summaries.js'

/**
 * #177 determinism proof over the #32 record/replay harness pattern: the SAME fixed inputs, replayed twice
 * into the REAL store + producer path across the WHOLE hierarchy (rolling → five-minute → session), yield
 * byte-identical Summaries with NO duplicate (level, window) heads — and a rebuild over an already-built
 * store appends nothing (idempotence). The summarizer is a DETERMINISTIC fake loopback (no real model, no
 * network) whose prose is a pure function of its bounded inputs, so the model layer stays reproducible too.
 */

const WS = 'workspace-synthetic'
const SES = 'session-synthetic'
const DIALS = { tone: 5, warmth: 5, wit: 5, charm: 5, specificity: 5, brevity: 5 }
const T0 = Date.parse('2026-07-16T13:00:00.000Z')

/** Deterministic prose — a pure function of the bounded child texts, so replay reproduces it exactly. */
const deterministicSummarizer: Summarizer = async (req) => ({
  text: `${req.level}(${req.windowStart}): ${req.childTexts.join(' / ')}`,
  slot: 'llm',
  endpoint: 'fixture-llm',
  model: 'fixture',
})

const session = (): Session => ({ id: SES, workspaceId: WS, modeId: 'mode-meeting', startedAt: '2026-07-16T13:00:00.000Z', attribution: { confidence: 1, evidence: [] } })

/** Seven distillates spread across ~six minutes → several 60s rolling windows, two five-minute windows, one session. */
const distillates = (): Distillate[] =>
  [0, 70, 140, 210, 300, 360, 420].map((sec, i) => {
    const at = new Date(T0 + sec * 1000).toISOString()
    return {
      id: `dist-${i}`, sessionId: SES, workspaceId: WS, windowStart: at, windowEnd: at, sourceChunks: [`c-${i}`],
      text: `point ${i}`, voice: { scope: 'global', dials: DIALS }, provenance: { slot: 'llm', endpoint: 'fake' }, schemaVersion: 1, createdAt: at,
    }
  })

const replayAndBuild = async (dir: string, now: () => Date): Promise<Summary[]> => {
  const store = new WorkspaceRegistry(dir)
  const docs = new DistillDocuments(store)
  docs.ensureDefaults() // seed the real shipped summary prompt documents (rolling/five-minute/session)
  try {
    store.saveSession(session())
    for (const d of distillates()) store.saveDistillate(d)
    const deps = { store, summaryTemplate: (l: Summary['level']) => docs.summaryTemplate(l), summarize: deterministicSummarizer, now }
    const scope = { workspaceId: WS, sessionId: SES, trigger: 'session-end' as const, levels: ['rolling', 'five-minute', 'session'] as const }
    await materializeSummaries(deps, scope)

    // Idempotence in the SAME store: an immediate rebuild over the converged state appends nothing.
    const again = await materializeSummaries({ ...deps, now: () => new Date('2027-01-01T00:00:00.000Z') }, scope)
    assert.equal(again.created.length, 0, 'rebuild over the same inputs appends nothing')

    return store.listSummaries(WS, { sessionId: SES, includeSuperseded: true })
  } finally {
    store.close()
  }
}

test('#177 replay: the same inputs replayed twice yield byte-identical summaries across the hierarchy, idempotently, with no duplicates', async () => {
  const fixture = loadFixtureSync(new URL('../../../../tools/fixtures/fixtures/synthetic-converged.v1.json', import.meta.url))
  const replay = createFixtureReplay(fixture)

  const dirA = await mkdtemp(join(tmpdir(), 'openinfo-sum-replay-a-'))
  const dirB = await mkdtemp(join(tmpdir(), 'openinfo-sum-replay-b-'))
  try {
    const first = await replayAndBuild(dirA, replay.now)
    replay.reset()
    const second = await replayAndBuild(dirB, replay.now)

    assert.equal(JSON.stringify(first), JSON.stringify(second), 'replay × 2 ⇒ byte-identical summaries')

    // NO DUPLICATES: each live (level, window) head is unique.
    const heads = first.filter((s) => !new Set(first.map((x) => x.supersedes).filter(Boolean)).has(s.id))
    const keys = heads.map((s) => `${s.level}|${s.windowStart}|${s.windowEnd}`)
    assert.equal(new Set(keys).size, keys.length, 'no duplicate (level, window) summaries')

    // The full hierarchy materialized, each level referencing the level below (refs only, model-proposal prose).
    const byLevel = (l: Summary['level']) => heads.filter((s) => s.level === l)
    assert.ok(byLevel('rolling').length >= 2, 'multiple rolling windows over the spread distillates')
    assert.ok(byLevel('five-minute').length >= 1, 'at least one five-minute window')
    assert.equal(byLevel('session').length, 1, 'exactly one durable session summary')

    const sessionSummary = byLevel('session')[0]!
    assert.equal(sessionSummary.proposal, true, 'prose is a model proposal, never canonical')
    assert.ok(sessionSummary.text !== undefined, 'the deterministic summarizer produced prose')
    assert.ok(sessionSummary.children.every((c) => c.record === 'summary' && c.level === 'five-minute'), 'session is built from five-minute summary refs')

    const fiveMinute = byLevel('five-minute')[0]!
    assert.ok(fiveMinute.children.some((c) => c.record === 'summary' && c.level === 'rolling'), 'five-minute is built from rolling summary refs')

    // Refs stay refs: no distillate PROSE was copied onto a rolling summary child (only ids + instants).
    for (const rolling of byLevel('rolling')) {
      for (const child of rolling.children) {
        assert.equal(Object.keys(child).sort().join(','), ['at', 'id', 'record', 'role'].join(','), 'a child is a bare ref — no copied content')
      }
    }
  } finally {
    await rm(dirA, { recursive: true, force: true })
    await rm(dirB, { recursive: true, force: true })
  }
})
