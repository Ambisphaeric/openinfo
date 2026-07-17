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

/**
 * The PREVIOUS shipped Standard App bodies, by the JSON the seed wrote (the #130 PREVIOUS_BUILTIN_BODIES
 * idiom, applied to the bundle document). ensureDefaults refreshes an install's seeded bundle to the new
 * shipped doc ONLY when it is provably UNEDITED — still version 1 AND byte-identical (after JSON
 * round-trip) to one of these — so an upgrader's chat plan gains a newly shipped source (the Ask face
 * `screen`) OR the newly shipped PILL hud face without EVER clobbering a user edit. Either signal
 * failing ⇒ the user owns it ⇒ untouched. Each entry is a body a PRIOR build shipped:
 *  1. pre-`screen` chat source, hud face → surf-openinfo-hud (the original launch body).
 *  2. + the `screen` chat source, hud face → surf-openinfo-hud (the P1×P2 chat-context body).
 *  3. + the pill hud face (surf-openinfo-pill), `screen` chat source, NO `packets` source (the pre-#180 body).
 * The CURRENT shipped body (bundle.standard-app.json) points the hud face at surf-openinfo-pill AND adds the
 * `packets` chat source (#180 — Ask grounded in current ContextPackets), so an unedited install on ANY prior
 * body refreshes onto it.
 */
export const PREVIOUS_DEFAULT_BUNDLE_BODIES: readonly string[] = [
  JSON.stringify({
    id: 'bundle-standard-app',
    name: 'Standard App',
    version: 1,
    description:
      'The MVP Standard App at glass parity (the pill). Its faces are the shipped HUD, chat, and support surfaces; it runs the default workflow with the default distill/extract/entities/follow-up templates. The first real instance proving the bundle-as-runtime-object contract — ship a different app later by shipping a different bundle document.',
    faces: [
      { kind: 'hud', surfaceRef: 'surf-openinfo-hud' },
      { kind: 'chat', surfaceRef: 'surf-openinfo-chat' },
      { kind: 'support', surfaceRef: 'surf-openinfo-fields' },
      { kind: 'support', surfaceRef: 'surf-openinfo-diagnostics' },
    ],
    workflowRef: 'workflow-default',
    templateRefs: ['tpl-distill-default', 'tpl-extract-default', 'tpl-entities-default', 'tpl-followup-default'],
    flags: { 'distill.enabled': true, 'distill.transcribe': true, 'distill.moments': true, 'distill.index': true, 'act.enabled': true },
    chat: {
      sources: [
        { kind: 'bundle-prompt' },
        { kind: 'active-preset' },
        { kind: 'transcript-window', windowChars: 4000 },
        { kind: 'insights', limit: 6 },
        { kind: 'relevant-entities', limit: 8 },
        { kind: 'attached-docs', limit: 4, tokenBudget: 1500 },
        { kind: 'recent-turns', limit: 8 },
      ],
    },
  }),
  JSON.stringify({
    id: 'bundle-standard-app',
    name: 'Standard App',
    version: 1,
    description:
      'The MVP Standard App at glass parity (the pill). Its faces are the shipped HUD, chat, and support surfaces; it runs the default workflow with the default distill/extract/entities/follow-up templates. The first real instance proving the bundle-as-runtime-object contract — ship a different app later by shipping a different bundle document.',
    faces: [
      { kind: 'hud', surfaceRef: 'surf-openinfo-hud' },
      { kind: 'chat', surfaceRef: 'surf-openinfo-chat' },
      { kind: 'support', surfaceRef: 'surf-openinfo-fields' },
      { kind: 'support', surfaceRef: 'surf-openinfo-diagnostics' },
    ],
    workflowRef: 'workflow-default',
    templateRefs: ['tpl-distill-default', 'tpl-extract-default', 'tpl-entities-default', 'tpl-followup-default'],
    flags: { 'distill.enabled': true, 'distill.transcribe': true, 'distill.moments': true, 'distill.index': true, 'act.enabled': true },
    chat: {
      sources: [
        { kind: 'bundle-prompt' },
        { kind: 'active-preset' },
        { kind: 'transcript-window', windowChars: 4000 },
        { kind: 'insights', limit: 6 },
        { kind: 'relevant-entities', limit: 8 },
        { kind: 'attached-docs', limit: 4, tokenBudget: 1500 },
        { kind: 'screen', tokenBudget: 1000 },
        { kind: 'recent-turns', limit: 8 },
      ],
    },
  }),
  JSON.stringify({
    id: 'bundle-standard-app',
    name: 'Standard App',
    version: 1,
    description:
      'The MVP Standard App at glass parity (the pill). Its faces are the shipped HUD, chat, and support surfaces; it runs the default workflow with the default distill/extract/entities/follow-up templates. The first real instance proving the bundle-as-runtime-object contract — ship a different app later by shipping a different bundle document.',
    faces: [
      { kind: 'hud', surfaceRef: 'surf-openinfo-pill' },
      { kind: 'chat', surfaceRef: 'surf-openinfo-chat' },
      { kind: 'support', surfaceRef: 'surf-openinfo-fields' },
      { kind: 'support', surfaceRef: 'surf-openinfo-diagnostics' },
    ],
    workflowRef: 'workflow-default',
    templateRefs: ['tpl-distill-default', 'tpl-extract-default', 'tpl-entities-default', 'tpl-followup-default'],
    flags: { 'distill.enabled': true, 'distill.transcribe': true, 'distill.moments': true, 'distill.index': true, 'act.enabled': true },
    chat: {
      sources: [
        { kind: 'bundle-prompt' },
        { kind: 'active-preset' },
        { kind: 'transcript-window', windowChars: 4000 },
        { kind: 'insights', limit: 6 },
        { kind: 'relevant-entities', limit: 8 },
        { kind: 'attached-docs', limit: 4, tokenBudget: 1500 },
        { kind: 'screen', tokenBudget: 1000 },
        { kind: 'recent-turns', limit: 8 },
      ],
    },
  }),
]
