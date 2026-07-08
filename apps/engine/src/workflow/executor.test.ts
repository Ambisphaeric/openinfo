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
  logs: string[]
}
const build = (flags: Record<string, boolean>, spec = defaultSpec(), opts: { transcribeThrows?: boolean; distillThrows?: boolean; acts?: string[] } = {}) => {
  const spy: Spy = { transcribeCalls: 0, distillCalls: [], drainNowCalls: 0, actCalls: [], logs: [] }
  const acts: Record<string, (s: Session) => Promise<void>> = {}
  for (const id of opts.acts ?? ['follow-up-draft']) acts[id] = async () => void spy.actCalls.push(id)
  const executor = new WorkflowExecutor({
    store: fakeStore(flags),
    docs: fakeDocs(spec),
    transcribe: async (c) => { spy.transcribeCalls += 1; if (opts.transcribeThrows) throw new Error('stt down'); return [...c] },
    distill: async (_c, o) => { spy.distillCalls.push({ opts: o }); if (opts.distillThrows) throw new Error('llm down'); return [] },
    drainNow: async () => void (spy.drainNowCalls += 1),
    acts,
    log: (m) => void spy.logs.push(m),
  })
  return { executor, spy }
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

test('runDrain: unwired kinds (ocr/vlm) on the drain skip-with-log, never crash; the distill still runs', async () => {
  const spec = defaultSpec()
  spec.steps.push({ id: 'screen-ocr', kind: 'ocr', trigger: 'drain', params: {} })
  const { executor, spy } = build({ 'distill.enabled': true }, spec)
  await executor.runDrain([chunk('a')])
  assert.equal(spy.distillCalls.length, 1)
  assert.ok(spy.logs.some((l) => l.includes('screen-ocr') && l.includes('no executor path yet')))
})

test('runDrain: an act step wrongly triggered on the drain is skipped-with-log (acts are session-end in v0)', async () => {
  const spec = defaultSpec()
  spec.steps.push({ id: 'stray-act', kind: 'act', trigger: 'drain', params: {} })
  const { executor, spy } = build({ 'distill.enabled': true }, spec)
  await executor.runDrain([chunk('a')])
  assert.ok(spy.logs.some((l) => l.includes('stray-act') && l.includes('acts run on session-end')))
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
