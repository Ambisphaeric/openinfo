#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { planCloseOut, selectNext } from './model.mjs'

const fixtureUrl = new URL('./fixtures/dry-run.json', import.meta.url)
const snapshot = JSON.parse(readFileSync(fixtureUrl, 'utf8'))
const original = JSON.stringify(snapshot)

const ordinary = selectNext(snapshot)
assert.equal(ordinary.selected, 204)
assert.equal(ordinary.stopped, false)
assert.deepEqual(ordinary.evaluations, [
  { number: 201, status: 'skipped', reason: 'closed' },
  { number: 202, status: 'blocked', reason: 'open dependencies: 900' },
  { number: 203, status: 'blocked', reason: 'owner required' },
  { number: 204, status: 'selected', reason: 'first open unblocked issue' },
])

const withOwner = selectNext(snapshot, { ownerPresent: true })
assert.equal(withOwner.selected, 203)

const dependencySatisfied = structuredClone(snapshot)
dependencySatisfied.issues.find(({ number }) => number === 900).state = 'CLOSED'
assert.equal(selectNext(dependencySatisfied).selected, 202)

const trackerFailure = structuredClone(snapshot)
trackerFailure.tracker.readable = false
assert.deepEqual(selectNext(trackerFailure), {
  selected: undefined,
  stopped: true,
  reason: 'GitHub tracker unreadable',
  evaluations: [],
})
const trackerUnknown = structuredClone(snapshot)
delete trackerUnknown.tracker.readable
assert.equal(selectNext(trackerUnknown).stopped, true)

const candidateFailure = structuredClone(snapshot)
candidateFailure.unreadableIssueNumbers = [202]
const stoppedCandidate = selectNext(candidateFailure)
assert.equal(stoppedCandidate.selected, undefined)
assert.equal(stoppedCandidate.stopped, true)
assert.equal(stoppedCandidate.reason, 'GitHub issue #202 unreadable')

const unknownState = structuredClone(snapshot)
unknownState.issues.find(({ number }) => number === 202).state = 'UNKNOWN'
const stoppedUnknown = selectNext(unknownState)
assert.equal(stoppedUnknown.selected, undefined)
assert.equal(stoppedUnknown.stopped, true)
assert.equal(stoppedUnknown.reason, 'GitHub issue #202 state is not known')

const evidence = {
  baselineSha: '1111111',
  headSha: '2222222',
  commits: ['2222222'],
  pullRequests: ['https://github.com/example/openinfo/pull/1'],
}
const passingCriteria = [
  { id: 'selection', verified: true },
  { id: 'history', verified: true },
]
const passingChecks = [
  { name: 'workflow dry run', status: 'passed' },
  { name: 'full test suite', status: 'passed' },
]
const incomplete = planCloseOut(snapshot, 204, {
  criteria: [{ id: 'selection', verified: true }, { id: 'history', verified: false }],
  checks: passingChecks,
  evidence,
})
assert.equal(incomplete.complete, false)
assert.equal(incomplete.actions.some(({ type }) => type === 'close-issue'), false)
assert.equal(incomplete.actions.at(-1).state, 'remains-in-flight')

const failedCheck = planCloseOut(snapshot, 204, {
  criteria: passingCriteria,
  checks: [{ name: 'workflow dry run', status: 'passed' }, { name: 'full test suite', status: 'failed' }],
  evidence,
})
assert.equal(failedCheck.complete, false)
assert.equal(failedCheck.actions.some(({ type }) => type === 'close-issue'), false)

const missingBaseline = planCloseOut(snapshot, 204, {
  criteria: passingCriteria,
  checks: passingChecks,
  evidence: { ...evidence, baselineSha: '' },
})
assert.equal(missingBaseline.complete, false)
assert.equal(missingBaseline.incomplete.includes('exact baseline SHA missing'), true)

const malformedEvidence = planCloseOut(snapshot, 204, {
  criteria: passingCriteria,
  checks: passingChecks,
  evidence: { ...evidence, commits: ['not-a-sha'], pullRequests: ['not-a-link'] },
})
assert.equal(malformedEvidence.complete, false)
assert.equal(malformedEvidence.incomplete.includes('commit SHA malformed'), true)
assert.equal(malformedEvidence.incomplete.includes('pull request link malformed'), true)

const missingCoverage = planCloseOut(snapshot, 204, {
  criteria: [{ id: 'selection', verified: true }],
  checks: [{ name: 'workflow dry run', status: 'passed' }],
  evidence,
})
assert.equal(missingCoverage.complete, false)
assert.equal(missingCoverage.incomplete.includes('acceptance criterion not enumerated: history'), true)
assert.equal(missingCoverage.incomplete.includes('verification check not enumerated: full test suite'), true)

const alreadyClosed = structuredClone(snapshot)
alreadyClosed.issues.find(({ number }) => number === 204).state = 'CLOSED'
const closedPlan = planCloseOut(alreadyClosed, 204, {
  criteria: passingCriteria,
  checks: passingChecks,
  evidence,
})
assert.equal(closedPlan.complete, false)
assert.equal(closedPlan.actions.some(({ type }) => type === 'close-issue'), false)
assert.equal(closedPlan.actions.at(-1).state, 'closed-needs-reconciliation')

const complete = planCloseOut(snapshot, 204, {
  criteria: passingCriteria,
  checks: passingChecks,
  evidence,
})
assert.equal(complete.complete, true)
assert.deepEqual(
  complete.actions.map(({ type }) => type),
  ['append-retro', 'close-issue', 'update-tracker', 'update-next'],
)
assert.deepEqual(
  complete.actions.filter(({ type }) => type === 'close-issue'),
  [{ type: 'close-issue', issue: 204 }],
)

assert.equal(JSON.stringify(snapshot), original, 'dry run mutated its input fixture')

console.log('workflow governance dry run: PASS')
console.log('  ordinary selection: #204 (live OPEN state wins over a stale checked tracker box)')
console.log('  closed, dependency-blocked, and owner-blocked items: handled in order')
console.log('  owner present: #203')
console.log('  dependency satisfied: #202')
console.log('  unreadable tracker/candidate: stopped before selection')
console.log('  unknown issue state: stopped before selection')
console.log('  unmet/unenumerated criterion, failed/unenumerated test, or missing baseline: no close')
console.log('  already-closed scoped issue: reconciled, never returned to in-flight')
console.log('  verified close-out: retro -> close -> tracker -> NEXT actions planned')
console.log('  external mutations: 0')
