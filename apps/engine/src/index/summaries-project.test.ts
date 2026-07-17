import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Distillate, Session, Summary } from '@openinfo/contracts'
import { WorkspaceRegistry } from '../store/index.js'
import { DistillDocuments } from '../distill/index.js'
import { materializeSummaries, type Summarizer } from './produce-summaries.js'

/**
 * #177 slice 2 — EPISODE + PROJECT production. Episode summaries derive over their bounded rolling children;
 * project summaries span sessions (no sessionId) and are APPEND-ONLY: a new session's result folds into a
 * SUPERSEDING project revision while every prior revision stays queryable — later sessions incorporated
 * without losing prior versions. The summarizer is a deterministic fake (no model, no network).
 */

const WS = 'ws-proj'
const DIALS = { tone: 5, warmth: 5, wit: 5, charm: 5, specificity: 5, brevity: 5 }

const deterministic: Summarizer = async (req) => ({ text: `${req.level}: ${req.childTexts.join(' / ')}`, slot: 'llm', endpoint: 'fixture', model: 'fixture' })

const seedSession = (store: WorkspaceRegistry, sessionId: string, base: string): void => {
  const session: Session = { id: sessionId, workspaceId: WS, modeId: 'mode-meeting', startedAt: base, attribution: { confidence: 1, evidence: [] } }
  store.saveSession(session)
  ;[0, 70, 140].forEach((sec, i) => {
    const at = new Date(Date.parse(base) + sec * 1000).toISOString()
    const d: Distillate = { id: `${sessionId}-dist-${i}`, sessionId, workspaceId: WS, windowStart: at, windowEnd: at, sourceChunks: [`${sessionId}-c-${i}`], text: `${sessionId} point ${i}`, voice: { scope: 'global', dials: DIALS }, provenance: { slot: 'llm', endpoint: 'fake' }, schemaVersion: 1, createdAt: at }
    store.saveDistillate(d)
  })
}

test('#177 episode + project: episode rolls up rolling children; project spans sessions append-only, incorporating later sessions without losing prior revisions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-sum-proj-'))
  const store = new WorkspaceRegistry(dir)
  const docs = new DistillDocuments(store)
  docs.ensureDefaults()
  try {
    const deps = { store, summaryTemplate: (l: Summary['level']) => docs.summaryTemplate(l), summarize: deterministic, now: () => new Date('2026-07-16T13:10:00.000Z') }
    const allLevels = ['rolling', 'episode', 'five-minute', 'session', 'project'] as const

    // ── Session 1 ends → its summaries + the FIRST project revision materialize.
    seedSession(store, 'ses-1', '2026-07-16T13:00:00.000Z')
    await materializeSummaries(deps, { workspaceId: WS, sessionId: 'ses-1', trigger: 'session-end', levels: allLevels })

    // EPISODE: a real level, session-scoped, built from rolling summary refs.
    const episodes = store.listSummaries(WS, { sessionId: 'ses-1', level: 'episode' })
    assert.ok(episodes.length >= 1, 'at least one episode summary')
    assert.ok(episodes[0]!.children.every((c) => c.record === 'summary' && c.level === 'rolling'), 'episode is built from rolling refs')
    assert.equal(episodes[0]!.sessionId, 'ses-1', 'episode is session-scoped')

    // PROJECT: cross-session — NO sessionId, built from the session summary, revision 1.
    let projects = store.listSummaries(WS, { level: 'project' })
    assert.equal(projects.length, 1, 'one live project summary after session 1')
    assert.equal(projects[0]!.sessionId, undefined, 'a project summary carries no sessionId (it spans sessions)')
    assert.equal(projects[0]!.revision, 1)
    const ses1SessionSummary = store.listSummaries(WS, { sessionId: 'ses-1', level: 'session' })[0]!
    assert.ok(projects[0]!.children.some((c) => c.id === ses1SessionSummary.id), 'project incorporates session 1’s session summary')
    const rev1Id = projects[0]!.id

    // ── Session 2 ends → a NEW project revision supersedes rev1, incorporating BOTH sessions.
    seedSession(store, 'ses-2', '2026-07-16T14:00:00.000Z')
    await materializeSummaries({ ...deps, now: () => new Date('2026-07-16T14:10:00.000Z') }, { workspaceId: WS, sessionId: 'ses-2', trigger: 'session-end', levels: allLevels })

    projects = store.listSummaries(WS, { level: 'project' })
    assert.equal(projects.length, 1, 'still exactly ONE live project head (the newest revision)')
    const head = projects[0]!
    assert.equal(head.revision, 2, 'the later session produced a superseding revision, not an overwrite')
    assert.equal(head.supersedes, rev1Id, 'the new revision names the prior as superseded (append-only chain)')
    const ses2SessionSummary = store.listSummaries(WS, { sessionId: 'ses-2', level: 'session' })[0]!
    assert.ok(head.children.some((c) => c.id === ses1SessionSummary.id), 'the project still incorporates session 1')
    assert.ok(head.children.some((c) => c.id === ses2SessionSummary.id), 'the project now ALSO incorporates the later session 2')

    // PRIOR VERSION NOT LOST: rev1 remains fully queryable via includeSuperseded.
    const chain = store.listSummaries(WS, { level: 'project', includeSuperseded: true })
    assert.equal(chain.length, 2, 'both project revisions retained (history is data)')
    assert.ok(chain.some((p) => p.id === rev1Id && p.revision === 1), 'the prior project revision is still queryable')
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
