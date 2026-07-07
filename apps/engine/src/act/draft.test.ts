import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Distillate, Draft, Mode, Moment, Session } from '@openinfo/contracts'
import { FabricDocuments } from '../fabric/index.js'
import { WorkspaceRegistry } from '../store/index.js'
import { VoiceDocuments } from '../voice/index.js'
import { defaultMeetingMode } from '../distill/index.js'
import { Actor, composeFollowUpDraft } from './index.js'
import { ActDocuments } from './documents.js'
import { defaultFollowUpTemplate } from './defaults.js'

const at = '2026-07-07T14:45:00Z'
const distillate = (id: string, text: string): Distillate => ({
  id, sessionId: 'ses-1', workspaceId: 'ws-1', windowStart: '2026-07-07T14:43:00Z', windowEnd: at,
  sourceChunks: [], text,
  voice: { scope: 'mode', dials: { tone: 3, warmth: 4, wit: 2, charm: 2, specificity: 9, brevity: 8 } },
  provenance: { slot: 'llm', endpoint: 'llm.fast' }, schemaVersion: 1, createdAt: at,
})
const moment = (id: string, kind: Moment['kind'], text: string): Moment => ({
  id, sessionId: 'ses-1', workspaceId: 'ws-1', at, kind, text, refs: [], source: 'mic', confidence: 0.8,
})

// A fake llm that ECHOES the prompt as the draft body — so a test can assert exactly which voice
// interpolations reached the model (mirrors the slice-4 session-voice e2e).
const echoInvoke = async (messages: { content: string }[]): Promise<{ text: string; endpoint: string; slot: 'llm'; model?: string }> => ({
  text: `DRAFT>> ${messages[0]!.content}`,
  endpoint: 'llm.fast',
  slot: 'llm',
  model: 'llama-3.2-3b',
})

test('composeFollowUpDraft builds a provenance-stamped draft from distillates + moments', async () => {
  const { draft, attempts } = await composeFollowUpDraft(
    {
      sessionId: 'ses-1', workspaceId: 'ws-1',
      distillates: [distillate('dst-1', 'agreed to ship Thursday'), distillate('dst-2', 'legal to review')],
      moments: [moment('mom-1', 'commitment', 'ship Thursday'), moment('mom-2', 'decision', 'route via legal')],
      dials: { tone: 3, warmth: 4, wit: 2, charm: 2, specificity: 9, brevity: 8 },
      scope: 'session', registerId: 'reg-boardroom', templateId: 'tpl-followup-default', templateVersion: 1,
    },
    { invoke: echoInvoke, template: defaultFollowUpTemplate },
  )
  assert.equal(attempts, 1)
  assert.ok(draft)
  assert.equal(draft.actKind, 'follow-up-draft')
  assert.equal(draft.status, 'prepared')
  assert.equal(draft.schemaVersion, 1)
  // provenance ties the draft back to its exact source records + the producing endpoint/template
  assert.deepEqual(draft.provenance.sourceDistillates, ['dst-1', 'dst-2'])
  assert.deepEqual(draft.provenance.sourceMoments, ['mom-1', 'mom-2'])
  assert.equal(draft.provenance.templateId, 'tpl-followup-default')
  assert.equal(draft.provenance.templateVersion, 1)
  assert.equal(draft.provenance.endpoint, 'llm.fast')
  assert.equal(draft.provenance.model, 'llama-3.2-3b')
  assert.equal(draft.voice.registerId, 'reg-boardroom')
  // both summaries and the glyph-rendered moments reached the model
  assert.match(draft.body, /agreed to ship Thursday/)
  assert.match(draft.body, /legal to review/)
  assert.match(draft.body, /● ship Thursday/)
  assert.match(draft.body, /▲ route via legal/)
})

test('a session with no distillates and no moments produces no draft (normal, not an error)', async () => {
  const { draft, attempts } = await composeFollowUpDraft(
    { sessionId: 'ses-1', workspaceId: 'ws-1', distillates: [], moments: [], dials: { tone: 5, warmth: 5, wit: 5, charm: 5, specificity: 5, brevity: 5 }, scope: 'global', templateId: 'tpl-followup-default' },
    { invoke: echoInvoke, template: defaultFollowUpTemplate },
  )
  assert.equal(draft, undefined)
  assert.equal(attempts, 0) // the llm is never called when there is nothing to draft
})

test('an empty completion is bounded-retried, then yields no draft', async () => {
  let calls = 0
  const blankInvoke = async (): Promise<{ text: string; endpoint: string; slot: 'llm' }> => {
    calls += 1
    return { text: '   ', endpoint: 'llm.fast', slot: 'llm' }
  }
  const { draft, attempts } = await composeFollowUpDraft(
    { sessionId: 'ses-1', workspaceId: 'ws-1', distillates: [distillate('dst-1', 's')], moments: [], dials: { tone: 5, warmth: 5, wit: 5, charm: 5, specificity: 5, brevity: 5 }, scope: 'global', templateId: 'tpl-followup-default' },
    { invoke: blankInvoke, template: defaultFollowUpTemplate, maxAttempts: 2 },
  )
  assert.equal(draft, undefined)
  assert.equal(attempts, 2)
  assert.equal(calls, 2)
})

test('the bound register visibly shapes the draft: boardroom vs sales-floor read differently', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-act-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const voice = new VoiceDocuments(store)
    voice.ensureDefaults()
    const docs = new ActDocuments(store)
    docs.ensureDefaults()
    const fabric = new FabricDocuments(store)

    // identical canned session material in the store for BOTH runs
    const seed = (sessionId: string): void => {
      store.saveDistillate({ ...distillate('dst-1', 'agreed to ship Thursday'), sessionId })
      store.saveMoment({ ...moment('mom-1', 'commitment', 'ship Thursday'), sessionId })
    }

    const drafts: Draft[] = []
    const actor = new Actor({
      store, voice, fabric, docs,
      mode: () => defaultMeetingMode, // declares a follow-up-draft act; registerId = reg-boardroom
      invoke: echoInvoke,
      publish: (d) => {
        drafts.push(d)
      },
    })

    // Session A: no register override → the mode default (boardroom) wins.
    const boardroom: Session = {
      id: 'ses-board', workspaceId: 'ws-1', modeId: 'mode-meeting', startedAt: at,
      attribution: { evidence: [{ kind: 'manual', detail: 'm', weight: 1 }], confidence: 1 },
    }
    seed('ses-board')
    const draftA = await actor.runFollowUpDraft(boardroom)

    // Session B: same meeting, but a session-scope sales-floor register — must win over the default.
    const salesFloor: Session = { ...boardroom, id: 'ses-sales', registerId: 'reg-sales-floor' }
    seed('ses-sales')
    const draftB = await actor.runFollowUpDraft(salesFloor)

    assert.ok(draftA && draftB)
    // resolution: A resolved boardroom at mode scope, B resolved sales-floor at session scope
    assert.equal(draftA.voice.registerId, 'reg-boardroom')
    assert.equal(draftA.voice.scope, 'mode')
    assert.equal(draftB.voice.registerId, 'reg-sales-floor')
    assert.equal(draftB.voice.scope, 'session')

    // the two drafts READ DIFFERENTLY — boardroom's clinical/high-specificity guidance vs
    // sales-floor's charismatic/high-charm guidance reached the model (the Phase-2 exit criterion)
    assert.match(draftA.body, /specificity 9\/10/)
    assert.match(draftA.body, /Avoid humor and banter entirely; stay clinical\./)
    assert.match(draftB.body, /charm 8\/10/)
    assert.match(draftB.body, /Be personable and charismatic\./)
    assert.notEqual(draftA.body, draftB.body)

    // both were persisted (store) and published (bus)
    assert.deepEqual(store.listDrafts('ws-1', 'ses-board').map((d) => d.id), [draftA.id])
    assert.deepEqual(store.listDrafts('ws-1', 'ses-sales').map((d) => d.id), [draftB.id])
    assert.deepEqual(drafts.map((d) => d.id).sort(), [draftA.id, draftB.id].sort())
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a mode that declares no follow-up-draft act produces no draft', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-act-'))
  const store = new WorkspaceRegistry(dir)
  try {
    const voice = new VoiceDocuments(store)
    voice.ensureDefaults()
    const docs = new ActDocuments(store)
    docs.ensureDefaults()
    store.saveDistillate(distillate('dst-1', 'agreed to ship Thursday'))
    const noActMode: Mode = { ...defaultMeetingMode, acts: [] }
    const actor = new Actor({ store, voice, fabric: new FabricDocuments(store), docs, mode: () => noActMode, invoke: echoInvoke })
    const session: Session = {
      id: 'ses-1', workspaceId: 'ws-1', modeId: 'mode-meeting', startedAt: at,
      attribution: { evidence: [{ kind: 'manual', detail: 'm', weight: 1 }], confidence: 1 },
    }
    assert.equal(await actor.runFollowUpDraft(session), undefined)
    assert.deepEqual(store.listDrafts('ws-1'), [])
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
