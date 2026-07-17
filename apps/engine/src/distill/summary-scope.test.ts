import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PromptTemplate } from '@openinfo/contracts'
import { resolveSummaryTemplate } from './documents.js'

/**
 * #177 slice 2 — summary cadence/templates are configurable PER WORKFLOW/APP scope, not only workspace-global
 * (the acceptance criterion "configurable per workflow/app scope"). The pure resolver picks the most-specific
 * matching binding for a level in a context (app > workflow > workspace — the voice-binding precedent), so two
 * scopes with different bindings each resolve their OWN, and the workspace-global one is the honest fallback.
 */

const tpl = (id: string, over: Partial<NonNullable<PromptTemplate['summary']>> = {}): PromptTemplate => ({
  id,
  name: id,
  kind: 'summary',
  slot: 'llm',
  builtin: true,
  body: 'summarize {{children}}',
  summary: { level: 'five-minute', windowMs: 300_000, childLevel: 'rolling', maxChildren: 5, ...over },
})

test('#177 scope: a workflow-scoped binding WINS over the workspace-global one for its workflow', () => {
  const global = tpl('tpl-global')
  const perFlowA = tpl('tpl-flow-a', { scope: 'workflow', targetId: 'flow-a', maxChildren: 2 })
  const perFlowB = tpl('tpl-flow-b', { scope: 'workflow', targetId: 'flow-b', maxChildren: 9 })
  const templates = [global, perFlowA, perFlowB]

  // Each workflow resolves ITS OWN binding — different cadence/bound per scope.
  assert.equal(resolveSummaryTemplate(templates, 'five-minute', { workflowId: 'flow-a' })?.id, 'tpl-flow-a')
  assert.equal(resolveSummaryTemplate(templates, 'five-minute', { workflowId: 'flow-b' })?.id, 'tpl-flow-b')
  // An unmatched workflow (or no context) falls back to the workspace-global binding — the honest default.
  assert.equal(resolveSummaryTemplate(templates, 'five-minute', { workflowId: 'flow-c' })?.id, 'tpl-global')
  assert.equal(resolveSummaryTemplate(templates, 'five-minute', {})?.id, 'tpl-global')
})

test('#177 scope: precedence is app > workflow > workspace, and a missing level resolves to nothing', () => {
  const global = tpl('tpl-global')
  const perFlow = tpl('tpl-flow', { scope: 'workflow', targetId: 'flow-a' })
  const perApp = tpl('tpl-app', { scope: 'app', targetId: 'surf-x' })
  const templates = [global, perFlow, perApp]

  // App scope is most specific — with both an app and a workflow match present, the app binding wins.
  assert.equal(resolveSummaryTemplate(templates, 'five-minute', { appId: 'surf-x', workflowId: 'flow-a' })?.id, 'tpl-app')
  // With only a workflow match, the workflow binding wins over the global.
  assert.equal(resolveSummaryTemplate(templates, 'five-minute', { workflowId: 'flow-a' })?.id, 'tpl-flow')
  // A level no binding produces resolves to undefined (that level simply does not run).
  assert.equal(resolveSummaryTemplate(templates, 'project', { appId: 'surf-x' }), undefined)
})
