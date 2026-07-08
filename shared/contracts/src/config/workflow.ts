import { Type, type Static } from '@sinclair/typebox'
import { Id, SlotName } from '../common.js'

/**
 * Append-only. The processing behaviors a workflow step can name — the pipeline primitives, one per
 * kind. CLOSED union on purpose (unlike `BlockTypeName`, which routes an unknown/forward type to the
 * `custom` fallback renderer): a block just *renders*, so skipping an unknown one is safe, but a step
 * *does work* and has no safe execution fallback — an executor cannot invent what a `foo` step means.
 * So an unrunnable kind must be rejected at document-write time (the Tier A JSON-Schema gate) rather
 * than silently no-op at runtime. Grows by appending here (mirrors `LocalRuntime`/`MomentKind`).
 *
 * Today's kinds and how they map to the hardcoded pipeline (api/http.ts drain + session.ended):
 *   transcribe — stt pre-distill stage (audio/* chunks → utf8 text)      [distill.transcribe]
 *   distill    — rolling-merge distiller over the drained chunks         [distill.enabled]
 *   moments    — typed-moment extraction riding the distill pass         [distill.moments]
 *   index      — entity extraction + recency×frequency index, same pass  [distill.index]
 *   act        — an Act (v0: the follow-up draft) on session end          [act.enabled]
 *   ocr / vlm  — screen understanding (P4B): named + homed here now, no executor path yet
 */
export const WorkflowStepKind = Type.Union(
  ['transcribe', 'ocr', 'vlm', 'distill', 'moments', 'index', 'act'].map((k) => Type.Literal(k)),
  { $id: 'WorkflowStepKind', description: 'append-only closed union of workflow step primitives' },
)
export type WorkflowStepKind = Static<typeof WorkflowStepKind>

/**
 * A per-step gate. v0 is deliberately a single feature-flag key: the step runs only when that flag is
 * enabled (the flags in `flag.examples.json`, e.g. `distill.enabled`). This keeps the default workflow
 * a faithful, editable mirror of today's per-flag wiring with NO condition language to execute yet.
 * DEFERRED (do not invent ahead of an executor that runs it): a condition DSL over session/mode/hardware
 * state — when it lands it becomes another optional member here (e.g. `condition?`), additively.
 */
export const StepGate = Type.Object(
  { flag: Type.String({ minLength: 1, description: 'a Flag key; the step runs only when this flag is enabled' }) },
  { $id: 'StepGate', additionalProperties: false },
)
export type StepGate = Static<typeof StepGate>

/**
 * One ordered step of a workflow. Array order IS the pipeline order (transcribe before distill before
 * the moments/index extras). `trigger` says WHICH seam fires the step: `drain` (the queue drain, the
 * idle/backlog path — the default) or `session-end` (the Act rides `session.ended`, not the drain — the
 * honest device for "act follows the meeting", per PHASE2-NOTES). `slot` names the fabric capability
 * slot the step invokes (stt for transcribe, llm for distill/act, ocr/vlm for screen); `templateId`
 * references a PromptTemplate/act-template document. `params` is a free bag the executor slice interprets.
 */
export const WorkflowStep = Type.Object(
  {
    id: Id,
    kind: WorkflowStepKind,
    slot: Type.Optional(SlotName),
    templateId: Type.Optional(Id),
    when: Type.Optional(StepGate),
    trigger: Type.Optional(
      Type.Union(['drain', 'session-end'].map((t) => Type.Literal(t)), {
        description: 'which seam fires this step; default drain',
      }),
    ),
    params: Type.Record(Type.String(), Type.Unknown(), { default: {} }),
  },
  { $id: 'WorkflowStep', additionalProperties: false },
)
export type WorkflowStep = Static<typeof WorkflowStep>

/**
 * A workflow document — ordered processing steps for a drain batch / session lifecycle. The
 * everything-is-a-document rule (ARCHITECTURE §2): a versioned, cloneable JSON config, so it gets the
 * templates/editor surfaces for free, like `Mode`/`Surface`/`FabricProfile`. Envelope follows the
 * house convention (id · name · version · description?). The executor (P4A slice 2) runs this document
 * against a drain batch, gated by a `workflow.enabled` flag with the legacy direct-wiring untouched
 * when OFF; slice 2 seeds a behavior-identical default (see `workflow.default.json`).
 *
 * The DAG deferral (workflow/README) still holds: this is a linear ordered list, not a graph — no
 * declared edges/fan-out. Steps that share a trigger and ride one underlying pass (distill + moments +
 * index all fold into ONE `distiller.distillChunks` call) are coalesced by the executor, NOT by this
 * document; the document stays the honest, per-flag-editable description. Chained/fan-out nodes force
 * the graph shape later, additively.
 */
export const WorkflowSpec = Type.Object(
  {
    id: Id,
    name: Type.String({ minLength: 1 }),
    version: Type.Integer({ minimum: 1, description: 'store-stamped, monotonic; every prior version is kept' }),
    description: Type.Optional(Type.String()),
    steps: Type.Array(WorkflowStep, { minItems: 1 }),
  },
  { $id: 'WorkflowSpec', additionalProperties: false },
)
export type WorkflowSpec = Static<typeof WorkflowSpec>
