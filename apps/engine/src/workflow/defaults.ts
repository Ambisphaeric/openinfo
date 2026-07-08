import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorkflowSpec } from '@openinfo/contracts'

const here = dirname(fileURLToPath(import.meta.url))
const examplesDir = join(here, '..', '..', '..', '..', 'shared', 'contracts', 'examples')

/** The id of the shipped default workflow (the behavior-identical pipeline mirror). */
export const DEFAULT_WORKFLOW_ID = 'workflow-default'

/**
 * The shipped default workflow, loaded from the SAME validated example the contract slice seeded
 * (shared/contracts/examples/workflow.default.json) — not inlined — so the document the executor runs is
 * byte-identical to the one contracts.test validates against WorkflowSpec. One source of truth, mirroring
 * api/defaults.ts::loadDefaultFlags. It mirrors the hardcoded pipeline: transcribe? → distill →
 * moments/index on the drain, and the follow-up-draft act on session-end (see workflow.default.json).
 */
export const loadDefaultWorkflow = (): WorkflowSpec =>
  JSON.parse(readFileSync(join(examplesDir, 'workflow.default.json'), 'utf8')) as WorkflowSpec
