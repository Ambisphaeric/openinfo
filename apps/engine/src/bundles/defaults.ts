import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Bundle } from '@openinfo/contracts'

const here = dirname(fileURLToPath(import.meta.url))
const examplesDir = join(here, '..', '..', '..', '..', 'shared', 'contracts', 'examples')

/** The id of the shipped default app bundle — the MVP "Standard App" (the pill), at glass parity. */
export const DEFAULT_BUNDLE_ID = 'bundle-standard-app'

/**
 * The shipped Standard App bundle, loaded from the SAME validated example the contract slice seeded
 * (shared/contracts/examples/bundle.standard-app.json) — not inlined — so the document the engine serves is
 * byte-identical to the one contracts.test validates against Bundle. One source of truth, mirroring
 * workflow/defaults.ts::loadDefaultWorkflow. Its faces reference only EXISTING seeded surfaces
 * (surf-openinfo-hud / -chat / -fields / -diagnostics), its workflowRef the seeded workflow-default, and
 * its templateRefs the seeded distill/extract/entities/follow-up templates — the first real bundle instance.
 */
export const loadDefaultBundle = (): Bundle =>
  JSON.parse(readFileSync(join(examplesDir, 'bundle.standard-app.json'), 'utf8')) as Bundle
