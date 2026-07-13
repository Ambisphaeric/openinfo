/**
 * Pure model of the /next selection and /retro close-out rules.
 * It deliberately has no GitHub client or filesystem access: callers must supply a snapshot.
 */

const issueIndex = (snapshot) => new Map(snapshot.issues.map((issue) => [issue.number, issue]))

export function selectNext(snapshot, { ownerPresent = false } = {}) {
  if (snapshot.tracker.readable !== true) {
    return { selected: undefined, stopped: true, reason: 'GitHub tracker unreadable', evaluations: [] }
  }
  const issues = issueIndex(snapshot)
  const evaluations = []

  for (const number of snapshot.tracker.order) {
    if (snapshot.unreadableIssueNumbers?.includes(number)) {
      return {
        selected: undefined,
        stopped: true,
        reason: `GitHub issue #${number} unreadable`,
        evaluations,
      }
    }
    const issue = issues.get(number)
    if (!issue) {
      return {
        selected: undefined,
        stopped: true,
        reason: `GitHub issue #${number} missing from snapshot`,
        evaluations,
      }
    }
    if (issue.state === 'CLOSED') {
      evaluations.push({ number, status: 'skipped', reason: 'closed' })
      continue
    }
    if (issue.state !== 'OPEN') {
      return {
        selected: undefined,
        stopped: true,
        reason: `GitHub issue #${number} state is not known`,
        evaluations,
      }
    }

    const unreadableDependency = issue.dependsOn.find(
      (dependency) => snapshot.unreadableIssueNumbers?.includes(dependency) || !issues.has(dependency),
    )
    if (unreadableDependency !== undefined) {
      return {
        selected: undefined,
        stopped: true,
        reason: `GitHub dependency #${unreadableDependency} unreadable`,
        evaluations,
      }
    }
    const unknownDependency = issue.dependsOn.find(
      (dependency) => !['OPEN', 'CLOSED'].includes(issues.get(dependency).state),
    )
    if (unknownDependency !== undefined) {
      return {
        selected: undefined,
        stopped: true,
        reason: `GitHub dependency #${unknownDependency} state is not known`,
        evaluations,
      }
    }
    const unmet = issue.dependsOn.filter((dependency) => issues.get(dependency).state !== 'CLOSED')
    if (unmet.length > 0) {
      evaluations.push({ number, status: 'blocked', reason: `open dependencies: ${unmet.join(', ')}` })
      continue
    }
    if (issue.ownerRequired && !ownerPresent) {
      evaluations.push({ number, status: 'blocked', reason: 'owner required' })
      continue
    }

    evaluations.push({ number, status: 'selected', reason: 'first open unblocked issue' })
    return { selected: number, stopped: false, evaluations }
  }

  return { selected: undefined, stopped: false, evaluations }
}

export function planCloseOut(snapshot, issueNumber, verification) {
  const issue = issueIndex(snapshot).get(issueNumber)
  if (!issue) throw new Error(`issue #${issueNumber} is absent from the snapshot`)

  const incomplete = []
  if (issue.state !== 'OPEN') incomplete.push('scoped issue is not open')
  if (!issue.requiredCriteria?.length) incomplete.push('required acceptance criteria snapshot missing')
  if (!issue.requiredChecks?.length) incomplete.push('required verification checks snapshot missing')
  const criterionIds = new Set(verification.criteria.map(({ id }) => id))
  const checkNames = new Set(verification.checks.map(({ name }) => name))
  for (const id of issue.requiredCriteria ?? []) {
    if (!criterionIds.has(id)) incomplete.push(`acceptance criterion not enumerated: ${id}`)
  }
  for (const name of issue.requiredChecks ?? []) {
    if (!checkNames.has(name)) incomplete.push(`verification check not enumerated: ${name}`)
  }
  for (const criterion of verification.criteria) {
    if (!criterion.verified) incomplete.push(`acceptance criterion not verified: ${criterion.id}`)
  }
  for (const check of verification.checks) {
    if (check.status !== 'passed') incomplete.push(`check not passed: ${check.name}`)
  }
  if (!verification.evidence.baselineSha) incomplete.push('exact baseline SHA missing')
  if (!verification.evidence.headSha) incomplete.push('exact head SHA missing')
  const sha = /^[0-9a-f]{7,40}$/i
  const pullRequest = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/
  if (verification.evidence.baselineSha && !sha.test(verification.evidence.baselineSha)) {
    incomplete.push('baseline SHA malformed')
  }
  if (verification.evidence.headSha && !sha.test(verification.evidence.headSha)) {
    incomplete.push('head SHA malformed')
  }
  if (verification.evidence.commits.some((commit) => !sha.test(commit))) {
    incomplete.push('commit SHA malformed')
  }
  if (verification.evidence.pullRequests.some((url) => !pullRequest.test(url))) {
    incomplete.push('pull request link malformed')
  }
  if (verification.evidence.commits.length === 0 && verification.evidence.pullRequests.length === 0) {
    incomplete.push('linked commit or pull request missing')
  }

  const complete = incomplete.length === 0
  const actions = [
    { type: 'append-retro', issue: issueNumber, complete },
    ...(complete
      ? [
          { type: 'close-issue', issue: issueNumber },
          { type: 'update-tracker', issue: issueNumber, checked: true },
          { type: 'update-next', issue: issueNumber, state: 'completed' },
        ]
      : [{
          type: 'update-next',
          issue: issueNumber,
          state: issue.state === 'CLOSED' ? 'closed-needs-reconciliation' : 'remains-in-flight',
        }]),
  ]

  return { complete, incomplete, actions }
}
