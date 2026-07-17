import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Summary } from '@openinfo/contracts'
import { assembleSummaries, buildSummary, type SummaryInput, type SummaryLevelConfig } from './summaries.js'

/**
 * The PURE assembler (#177): deterministic bucketing, the EXPLICIT input bound, deterministic confidence,
 * idempotence, and append-only supersession — all with no store, clock, or model. These are the acceptance
 * criteria "bounded lower-level inputs, never unbounded raw history" and "updating an active interval
 * supersedes" proven at the smallest possible level.
 */

const ROLLING: SummaryLevelConfig = { level: 'rolling', windowMs: 60_000, maxChildren: 6, maxEvidence: 3, templateId: 'tpl-summary-rolling' }
const T0 = Date.parse('2026-07-16T13:00:00.000Z')

/** A distillate-shaped child input at T0 + `sec` seconds, carrying prose. */
const child = (sec: number, text: string): SummaryInput => {
  const at = new Date(T0 + sec * 1000).toISOString()
  return { ref: { record: 'distillate', id: `d-${sec}`, at, role: 'child' }, windowStart: at, windowEnd: at, text }
}
const evidenceMoment = (sec: number, text: string): SummaryInput => {
  const at = new Date(T0 + sec * 1000).toISOString()
  return { ref: { record: 'moment', id: `m-${sec}`, at, role: 'evidence' }, windowStart: at, windowEnd: at, text }
}

const proseOf = (text: string): Parameters<typeof buildSummary>[2] => ({ text, slot: 'llm', endpoint: 'fake' })

test('#177 the input is BOUNDED: an over-long window keeps only maxChildren (newest), and records the bound', () => {
  // Eight children inside one 60s window; maxChildren is 6 → the two oldest are dropped, never fed to the model.
  const children = Array.from({ length: 8 }, (_, i) => child(i, `line ${i}`))
  const { plan } = assembleSummaries({ workspaceId: 'w', sessionId: 's', config: ROLLING, children, evidence: [], existing: [] })
  assert.equal(plan.length, 1, 'all eight fall in one 60s rolling window')
  const item = plan[0]!
  assert.equal(item.bound.childrenAvailable, 8, 'the bound is honest about what existed')
  assert.equal(item.bound.childrenConsumed, 6, 'no more than maxChildren is consumed — never unbounded raw history')
  assert.equal(item.childTexts.length, 6, 'exactly the bounded prose inputs reach the summarizer')
  assert.deepEqual(item.childTexts, ['line 2', 'line 3', 'line 4', 'line 5', 'line 6', 'line 7'], 'the NEWEST are kept, chronological')
  assert.equal(item.refs.filter((r) => r.role === 'child').length, 6, 'only the bounded children are referenced')
  assert.equal(item.confidence, 0.9, 'confidence is a deterministic band from the consumed count, capped')
})

test('#177 evidence is separately bounded and role-tagged', () => {
  const children = [child(1, 'a'), child(2, 'b')]
  const evidence = Array.from({ length: 5 }, (_, i) => evidenceMoment(3 + i, `moment ${i}`))
  const { plan } = assembleSummaries({ workspaceId: 'w', sessionId: 's', config: ROLLING, children, evidence, existing: [] })
  const item = plan[0]!
  assert.equal(item.bound.evidenceAvailable, 5)
  assert.equal(item.bound.evidenceConsumed, 3, 'evidence honors maxEvidence independently of children')
  assert.equal(item.refs.filter((r) => r.role === 'evidence').length, 3)
  assert.equal(item.evidenceTexts.length, 3)
})

test('#177 idempotence + append-only supersession on a changed child set', () => {
  const first = assembleSummaries({ workspaceId: 'w', sessionId: 's', config: ROLLING, children: [child(1, 'a'), child(2, 'b')], evidence: [], existing: [] })
  assert.equal(first.plan.length, 1)
  const head = buildSummary(first.plan[0]!, { workspaceId: 'w', sessionId: 's', level: 'rolling' }, proseOf('summary one'), '2026-07-16T13:01:01.000Z')
  assert.equal(head.revision, 1)
  assert.equal(head.proposal, true, 'prose is marked a model proposal')

  // Re-assemble over the SAME children with the head present ⇒ idempotent no-op (nothing to (re)summarize).
  const again = assembleSummaries({ workspaceId: 'w', sessionId: 's', config: ROLLING, children: [child(1, 'a'), child(2, 'b')], evidence: [], existing: [head] })
  assert.equal(again.plan.length, 0, 'a stable child set produces nothing new')
  assert.equal(again.unchanged.length, 1)
  assert.equal(again.unchanged[0]!.head.id, head.id)

  // A NEW child in the active interval ⇒ a superseding revision, never a rewrite of the prior.
  const changed = assembleSummaries({ workspaceId: 'w', sessionId: 's', config: ROLLING, children: [child(1, 'a'), child(2, 'b'), child(3, 'c')], evidence: [], existing: [head] })
  assert.equal(changed.plan.length, 1)
  assert.equal(changed.plan[0]!.revision, 2, 'the update is a new version')
  assert.equal(changed.plan[0]!.supersedes, head.id, 'it supersedes the prior head, which is left intact')
  assert.notEqual(changed.plan[0]!.id, head.id, 'a new revision has a distinct content-derived id')
})

test('#177 a config change actually changes behavior (maxChildren tightens the bound and the id)', () => {
  const children = Array.from({ length: 5 }, (_, i) => child(i, `line ${i}`))
  const loose = assembleSummaries({ workspaceId: 'w', sessionId: 's', config: { ...ROLLING, maxChildren: 5 }, children, evidence: [], existing: [] }).plan[0]!
  const tight = assembleSummaries({ workspaceId: 'w', sessionId: 's', config: { ...ROLLING, maxChildren: 2 }, children, evidence: [], existing: [] }).plan[0]!
  assert.equal(loose.bound.childrenConsumed, 5)
  assert.equal(tight.bound.childrenConsumed, 2, 'the config document, not code, decides the bound')
  assert.notEqual(loose.id, tight.id, 'the bound is part of the content-derived id — behavior visibly changed')
})

test('#177 the session level buckets the WHOLE session into one summary spanning its children', () => {
  const config: SummaryLevelConfig = { level: 'session', windowMs: 300_000, childLevel: 'five-minute', maxChildren: 12, maxEvidence: 0, templateId: 'tpl-summary-session' }
  // Two five-minute children 10 minutes apart still collapse into ONE session summary (windowMs ignored).
  const children: SummaryInput[] = [
    { ref: { record: 'summary', id: 'fm-1', at: '2026-07-16T13:00:00.000Z', role: 'child', level: 'five-minute' }, windowStart: '2026-07-16T13:00:00.000Z', windowEnd: '2026-07-16T13:05:00.000Z', text: 'first five' },
    { ref: { record: 'summary', id: 'fm-2', at: '2026-07-16T13:10:00.000Z', role: 'child', level: 'five-minute' }, windowStart: '2026-07-16T13:10:00.000Z', windowEnd: '2026-07-16T13:15:00.000Z', text: 'second five' },
  ]
  const { plan } = assembleSummaries({ workspaceId: 'w', sessionId: 's', config, children, evidence: [], existing: [] })
  assert.equal(plan.length, 1, 'one session summary, not one per window')
  assert.equal(plan[0]!.windowStart, '2026-07-16T13:00:00.000Z')
  assert.equal(plan[0]!.windowEnd, '2026-07-16T13:15:00.000Z', 'the window spans the children min→max')
  assert.equal(plan[0]!.windowMs, 0, 'whole-session bucketing records windowMs 0 in provenance')
})

test('#177 buildSummary marks a degraded summary honestly — no prose, explicit reason, refs intact', () => {
  const { plan } = assembleSummaries({ workspaceId: 'w', sessionId: 's', config: ROLLING, children: [child(1, 'a')], evidence: [], existing: [] })
  const degraded: Summary = buildSummary(plan[0]!, { workspaceId: 'w', sessionId: 's', level: 'rolling' }, { degraded: 'no summarizer endpoint' }, '2026-07-16T13:01:01.000Z')
  assert.equal(degraded.text, undefined, 'no fabricated prose')
  assert.equal(degraded.degraded?.reason, 'no summarizer endpoint')
  assert.equal(degraded.provenance.slot, undefined, 'no invoke provenance is claimed for a call that did not happen')
  assert.ok(degraded.children.length > 0, 'the deterministic derivation path is still intact')
  assert.equal(degraded.proposal, true)
})
