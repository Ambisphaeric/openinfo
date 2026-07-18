import test from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk, Flag, Session, WorkflowSpec } from '@openinfo/contracts'
import type { WorkspaceRegistry } from '../store/index.js'
import type { WorkflowDocuments } from './documents.js'
import { WorkflowExecutor } from './executor.js'

// --- minimal fakes ---------------------------------------------------------
// The executor touches the store ONLY through isFlagEnabled (store.layouts.getLatest('flag', key)),
// and the document ONLY through docs.active(). So a flag map + a fixed spec are the whole surface.
const fakeStore = (flags: Record<string, boolean>): WorkspaceRegistry =>
  ({
    layouts: {
      getLatest: (kind: string, key: string) =>
        kind === 'flag' && key in flags ? ({ body: { default: flags[key] } as Flag }) : undefined,
    },
  }) as unknown as WorkspaceRegistry

const fakeDocs = (spec: WorkflowSpec): WorkflowDocuments => ({ active: () => spec }) as unknown as WorkflowDocuments

const chunk = (id: string): CaptureChunk =>
  ({ id, sessionId: 's1', workspaceId: 'default', source: 'mic', sequence: 0, capturedAt: '2026-07-08T00:00:00.000Z', contentType: 'text/plain', encoding: 'utf8', data: 'x' }) as CaptureChunk
const screenChunk = (id: string): CaptureChunk =>
  ({ id, sessionId: 's1', workspaceId: 'default', source: 'screen', sequence: 0, capturedAt: '2026-07-08T00:00:00.000Z', contentType: 'image/jpeg', encoding: 'base64', data: 'aW1n' }) as CaptureChunk
const session = (): Session => ({ id: 's1' }) as unknown as Session

// The behavior-identical default document (the shape the executor coalesces): transcribe? -> distill ->
// moments/index on the drain; the follow-up-draft act on session-end.
const defaultSpec = (): WorkflowSpec => ({
  id: 'workflow-default', name: 'default', version: 1,
  steps: [
    { id: 'transcribe', kind: 'transcribe', slot: 'stt', trigger: 'drain', when: { flag: 'distill.transcribe' }, params: {} },
    { id: 'distill', kind: 'distill', slot: 'llm', trigger: 'drain', when: { flag: 'distill.enabled' }, params: {} },
    { id: 'moments', kind: 'moments', trigger: 'drain', when: { flag: 'distill.moments' }, params: {} },
    { id: 'index', kind: 'index', trigger: 'drain', when: { flag: 'distill.index' }, params: {} },
    { id: 'follow-up-draft', kind: 'act', slot: 'llm', trigger: 'session-end', when: { flag: 'act.enabled' }, params: {} },
  ],
})

interface Spy {
  transcribeCalls: number
  distillCalls: { opts: { extractMoments?: boolean; extractEntities?: boolean } }[]
  drainNowCalls: number
  actCalls: string[]
  drainActCalls: string[]
  screenCalls: { stepId: string; kind: string; count: number }[]
  logs: string[]
}
const build = (
  flags: Record<string, boolean>,
  spec = defaultSpec(),
  opts: { transcribeThrows?: boolean; distillThrows?: boolean; acts?: string[]; drainActs?: string[]; drainActThrows?: string; recognizeScreen?: boolean; screenThrows?: boolean } = {},
) => {
  const spy: Spy = { transcribeCalls: 0, distillCalls: [], drainNowCalls: 0, actCalls: [], drainActCalls: [], screenCalls: [], logs: [] }
  const acts: Record<string, (s: Session) => Promise<void>> = {}
  for (const id of opts.acts ?? ['follow-up-draft']) acts[id] = async () => void spy.actCalls.push(id)
  const drainActs: Record<string, (c: readonly CaptureChunk[]) => Promise<void>> = {}
  for (const id of opts.drainActs ?? []) {
    drainActs[id] = async () => {
      if (opts.drainActThrows === id) throw new Error(`${id} boom`)
      spy.drainActCalls.push(id)
    }
  }
  const executor = new WorkflowExecutor({
    store: fakeStore(flags),
    docs: fakeDocs(spec),
    transcribe: async (c) => { spy.transcribeCalls += 1; if (opts.transcribeThrows) throw new Error('stt down'); return [...c] },
    distill: async (_c, o) => { spy.distillCalls.push({ opts: o }); if (opts.distillThrows) throw new Error('llm down'); return [] },
    drainNow: async () => void (spy.drainNowCalls += 1),
    acts,
    drainActs,
    ...(opts.recognizeScreen
      ? {
          recognizeScreen: async (chunks: readonly CaptureChunk[], step: { id: string; kind: string }) => {
            if (opts.screenThrows) throw new Error('ocr down')
            spy.screenCalls.push({ stepId: step.id, kind: step.kind, count: chunks.filter((c) => c.source === 'screen').length })
          },
        }
      : {}),
    log: (m) => void spy.logs.push(m),
  })
  return { executor, spy }
}

/** The default spec with an `ocr` drain step (gated screen.ocr), as the seeded default now carries. */
const withScreenOcr = (): WorkflowSpec => {
  const spec = defaultSpec()
  spec.steps.splice(1, 0, { id: 'screen-ocr', kind: 'ocr', slot: 'ocr', trigger: 'drain', when: { flag: 'screen.ocr' }, params: {} })
  return spec
}

/** A drain-triggered task-extract act step (gated act.tasks), appended to the default spec. */
const withTaskExtract = (): WorkflowSpec => {
  const spec = defaultSpec()
  spec.steps.splice(4, 0, { id: 'task-extract', kind: 'act', slot: 'llm', trigger: 'drain', when: { flag: 'act.tasks' }, params: {} })
  return spec
}

// --- drain seam ------------------------------------------------------------
test('runDrain: full pass — transcribe runs, distill gets both extract options', async () => {
  const { executor, spy } = build({ 'distill.enabled': true, 'distill.transcribe': true, 'distill.moments': true, 'distill.index': true })
  await executor.runDrain([chunk('a')])
  assert.equal(spy.transcribeCalls, 1)
  assert.equal(spy.distillCalls.length, 1)
  assert.deepEqual(spy.distillCalls[0]!.opts, { extractMoments: true, extractEntities: true })
})

test('runDrain: distill flag OFF → nothing runs (no transcribe, no distill) — mirrors legacy `if (!distill.enabled) return`', async () => {
  const { executor, spy } = build({ 'distill.enabled': false, 'distill.transcribe': true, 'distill.moments': true })
  await executor.runDrain([chunk('a')])
  assert.equal(spy.transcribeCalls, 0)
  assert.equal(spy.distillCalls.length, 0)
})

test('runDrain: transcribe flag OFF → distill runs on the RAW chunks, transcribe skipped', async () => {
  const { executor, spy } = build({ 'distill.enabled': true, 'distill.transcribe': false })
  await executor.runDrain([chunk('a')])
  assert.equal(spy.transcribeCalls, 0)
  assert.equal(spy.distillCalls.length, 1)
  assert.deepEqual(spy.distillCalls[0]!.opts, { extractMoments: false, extractEntities: false })
})

test('runDrain: moments/index gate independently (moments on, index off)', async () => {
  const { executor, spy } = build({ 'distill.enabled': true, 'distill.moments': true, 'distill.index': false })
  await executor.runDrain([chunk('a')])
  assert.deepEqual(spy.distillCalls[0]!.opts, { extractMoments: true, extractEntities: false })
})

// The default spec with the moments/index drain steps REMOVED — a legally authored workflow that
// distills but declares no extraction steps. Before #244 this silently forced extraction OFF even with
// the Settings toggle ON (the headline QA defect: `workflow.enabled` ON ⇒ empty Moments/Relevant-now).
const withoutExtractSteps = (): WorkflowSpec => {
  const spec = defaultSpec()
  spec.steps = spec.steps.filter((s) => s.kind !== 'moments' && s.kind !== 'index')
  return spec
}

test('runDrain: FLAG-AUTHORITATIVE — no moments/index step but the flags are ON ⇒ extraction runs (the #244 silent-inert case)', async () => {
  const { executor, spy } = build(
    { 'distill.enabled': true, 'distill.moments': true, 'distill.index': true },
    withoutExtractSteps(),
  )
  await executor.runDrain([chunk('a')])
  assert.equal(spy.distillCalls.length, 1)
  // The exact regression: with the steps absent the flags MUST still drive extraction, so a Settings
  // toggle is never silently inert under the workflow path.
  assert.deepEqual(spy.distillCalls[0]!.opts, { extractMoments: true, extractEntities: true })
})

test('runDrain: FLAG-AUTHORITATIVE — no step + flags OFF ⇒ no extraction (flag is the authority both ways)', async () => {
  const { executor, spy } = build(
    { 'distill.enabled': true, 'distill.moments': false, 'distill.index': false },
    withoutExtractSteps(),
  )
  await executor.runDrain([chunk('a')])
  assert.deepEqual(spy.distillCalls[0]!.opts, { extractMoments: false, extractEntities: false })
})

test('runDrain: a PRESENT moments step still RE-BINDS the gate (advanced composition) — its when-flag governs, not the default flag', async () => {
  // moments step gated on a CUSTOM flag that is OFF, while the default distill.moments flag is ON: the
  // present step wins (extraction off), proving the document stays meaningful as data (a step can re-bind
  // the gate) — only the ABSENCE of a step falls back to the Settings flag.
  const spec = defaultSpec()
  const moments = spec.steps.find((s) => s.kind === 'moments')!
  moments.when = { flag: 'custom.moments' }
  const { executor, spy } = build({ 'distill.enabled': true, 'distill.moments': true, 'custom.moments': false }, spec)
  await executor.runDrain([chunk('a')])
  assert.equal(spy.distillCalls[0]!.opts.extractMoments, false)
})

test('runDrain: COALESCES the distill family into exactly ONE distill call', async () => {
  const { executor, spy } = build({ 'distill.enabled': true, 'distill.moments': true, 'distill.index': true })
  await executor.runDrain([chunk('a'), chunk('b')])
  assert.equal(spy.distillCalls.length, 1)
})

test('runDrain: a transcribe throw PROPAGATES (drain re-queues, retry-at-idle)', async () => {
  const { executor } = build({ 'distill.enabled': true, 'distill.transcribe': true }, defaultSpec(), { transcribeThrows: true })
  await assert.rejects(() => executor.runDrain([chunk('a')]), /stt down/)
})

test('runDrain: a distill throw PROPAGATES (drain re-queues, retry-at-idle)', async () => {
  const { executor } = build({ 'distill.enabled': true }, defaultSpec(), { distillThrows: true })
  await assert.rejects(() => executor.runDrain([chunk('a')]), /llm down/)
})

test('runDrain: an ocr step gated ON with a seam runs the screen-recognition drain stage', async () => {
  const { executor, spy } = build({ 'distill.enabled': true, 'screen.ocr': true }, withScreenOcr(), { recognizeScreen: true })
  await executor.runDrain([chunk('a'), screenChunk('img')])
  assert.equal(spy.distillCalls.length, 1) // distill still ran
  assert.deepEqual(spy.screenCalls, [{ stepId: 'screen-ocr', kind: 'ocr', count: 1 }])
})

test('runDrain: an ocr step gated OFF (default) is skipped SILENTLY — behavior-identical, seam never called', async () => {
  const { executor, spy } = build({ 'distill.enabled': true, 'screen.ocr': false }, withScreenOcr(), { recognizeScreen: true })
  await executor.runDrain([chunk('a'), screenChunk('img')])
  assert.equal(spy.distillCalls.length, 1)
  assert.deepEqual(spy.screenCalls, [])
  assert.ok(!spy.logs.some((l) => l.includes('screen-ocr'))) // no noise for the OFF default
})

test('runDrain: an ocr step gated ON with NO seam registered skips-with-log, never crashes; distill still runs', async () => {
  const { executor, spy } = build({ 'distill.enabled': true, 'screen.ocr': true }, withScreenOcr())
  await executor.runDrain([chunk('a'), screenChunk('img')])
  assert.equal(spy.distillCalls.length, 1)
  assert.ok(spy.logs.some((l) => l.includes('screen-ocr') && l.includes('no screen-recognition seam')))
})

test('runDrain: a screen-recognition throw PROPAGATES (drain re-queues) — NOT best-effort, and BEFORE distill runs', async () => {
  const { executor, spy } = build({ 'distill.enabled': true, 'screen.ocr': true }, withScreenOcr(), { recognizeScreen: true, screenThrows: true })
  await assert.rejects(() => executor.runDrain([screenChunk('img')]), /ocr down/)
  assert.equal(spy.distillCalls.length, 0) // ocr runs before the distill gate, so distill never persisted
})

test('runDrain: screen recognition runs INDEPENDENTLY of distill.enabled (a frame is understood by OCR, not the distiller)', async () => {
  const { executor, spy } = build({ 'distill.enabled': false, 'screen.ocr': true }, withScreenOcr(), { recognizeScreen: true })
  await executor.runDrain([screenChunk('img')])
  assert.equal(spy.distillCalls.length, 0) // distill OFF, correctly skipped
  assert.deepEqual(spy.screenCalls, [{ stepId: 'screen-ocr', kind: 'ocr', count: 1 }]) // but screen still recognized
})

test('runDrain: a vlm step routes to the same seam carrying its kind', async () => {
  const spec = defaultSpec()
  spec.steps.splice(1, 0, { id: 'screen-vlm', kind: 'vlm', slot: 'vlm', trigger: 'drain', when: { flag: 'screen.ocr' }, params: {} })
  const { executor, spy } = build({ 'distill.enabled': true, 'screen.ocr': true }, spec, { recognizeScreen: true })
  await executor.runDrain([screenChunk('img')])
  assert.deepEqual(spy.screenCalls, [{ stepId: 'screen-vlm', kind: 'vlm', count: 1 }])
})

test('runDrain: task-extract drain act — gated ON with a runner RUNS after the distill pass', async () => {
  const { executor, spy } = build({ 'distill.enabled': true, 'act.tasks': true }, withTaskExtract(), { drainActs: ['task-extract'] })
  await executor.runDrain([chunk('a')])
  assert.equal(spy.distillCalls.length, 1) // distill still ran
  assert.deepEqual(spy.drainActCalls, ['task-extract'])
})

test('runDrain: task-extract drain act — gated OFF (default) is skipped SILENTLY (behavior-identical)', async () => {
  const { executor, spy } = build({ 'distill.enabled': true, 'act.tasks': false }, withTaskExtract(), { drainActs: ['task-extract'] })
  await executor.runDrain([chunk('a')])
  assert.equal(spy.distillCalls.length, 1)
  assert.deepEqual(spy.drainActCalls, [])
  assert.ok(!spy.logs.some((l) => l.includes('task-extract'))) // no noise for the OFF default
})

test('runDrain: a gated-ON drain act with NO registered runner is skipped-with-log, never crashes', async () => {
  const { executor, spy } = build({ 'distill.enabled': true, 'act.tasks': true }, withTaskExtract(), { drainActs: [] })
  await executor.runDrain([chunk('a')])
  assert.equal(spy.distillCalls.length, 1)
  assert.ok(spy.logs.some((l) => l.includes('task-extract') && l.includes('no runner registered')))
})

test('runDrain: a drain act throw is CAUGHT (best-effort) — never re-queues the already-distilled batch', async () => {
  const { executor, spy } = build({ 'distill.enabled': true, 'act.tasks': true }, withTaskExtract(), { drainActs: ['task-extract'], drainActThrows: 'task-extract' })
  await executor.runDrain([chunk('a')]) // must NOT reject
  assert.equal(spy.distillCalls.length, 1)
  assert.ok(spy.logs.some((l) => l.includes('task-extract') && l.includes('best-effort')))
})

test('runDrain: distill OFF → task-extract does NOT run (it rides the distill pass)', async () => {
  const { executor, spy } = build({ 'distill.enabled': false, 'act.tasks': true }, withTaskExtract(), { drainActs: ['task-extract'] })
  await executor.runDrain([chunk('a')])
  assert.equal(spy.distillCalls.length, 0)
  assert.deepEqual(spy.drainActCalls, [])
})

// --- session-end seam ------------------------------------------------------
test('runSessionEnd: act enabled → drainNow FIRST, then the act runner (drain-first flush)', async () => {
  const order: string[] = []
  const { executor, spy } = build({ 'act.enabled': true })
  // instrument order by wrapping via the spy counts + a probe act
  const probe = new WorkflowExecutor({
    store: fakeStore({ 'act.enabled': true }),
    docs: fakeDocs(defaultSpec()),
    transcribe: async (c) => [...c],
    distill: async () => [],
    drainNow: async () => void order.push('drain'),
    acts: { 'follow-up-draft': async () => void order.push('act') },
  })
  await probe.runSessionEnd(session())
  assert.deepEqual(order, ['drain', 'act'])
  // and the simple spy path also fired both
  await executor.runSessionEnd(session())
  assert.equal(spy.drainNowCalls, 1)
  assert.deepEqual(spy.actCalls, ['follow-up-draft'])
})

test('runSessionEnd: act DISABLED → no drain, no act (mirrors legacy `if (!act.enabled) return` — never drains)', async () => {
  const { executor, spy } = build({ 'act.enabled': false })
  await executor.runSessionEnd(session())
  assert.equal(spy.drainNowCalls, 0)
  assert.deepEqual(spy.actCalls, [])
})

test('runSessionEnd: an act step with no registered runner is skipped-with-log, never crashes', async () => {
  const spec = defaultSpec()
  spec.steps.push({ id: 'task-extract', kind: 'act', trigger: 'session-end', when: { flag: 'act.enabled' }, params: {} })
  const { executor, spy } = build({ 'act.enabled': true }, spec, { acts: ['follow-up-draft'] })
  await executor.runSessionEnd(session())
  assert.deepEqual(spy.actCalls, ['follow-up-draft'])
  assert.ok(spy.logs.some((l) => l.includes('task-extract') && l.includes('no runner registered')))
})

test('trigger split: a session-end act does NOT run on the drain, and drain steps do NOT run on session-end', async () => {
  const { executor, spy } = build({ 'distill.enabled': true, 'act.enabled': true })
  await executor.runDrain([chunk('a')])
  assert.deepEqual(spy.actCalls, []) // the follow-up-draft act never fired on the drain
  const { executor: e2, spy: s2 } = build({ 'distill.enabled': true, 'act.enabled': true })
  await e2.runSessionEnd(session())
  assert.equal(s2.distillCalls.length, 0) // the drain distill never fired on session-end
  assert.deepEqual(s2.actCalls, ['follow-up-draft'])
})
