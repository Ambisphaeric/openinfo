import type { CaptureChunk, Session, StepGate, WorkflowStep } from '@openinfo/contracts'
import type { DistillOptions } from '../distill/index.js'
import { isFlagEnabled } from '../flags/read.js'
import type { WorkspaceRegistry } from '../store/index.js'
import type { WorkflowDocuments } from './documents.js'

/**
 * Array order IS pipeline order; a step's seam is its `trigger` (default drain). Returns a bare string
 * because `WorkflowStep.trigger` Static-infers as `string` (the union-of-literals `.map` quirk in the
 * contract) — the executor only ever compares it against the two known seam names.
 */
const seamOf = (step: WorkflowStep): string => step.trigger ?? 'drain'

/** An act runner keyed by the act step's id (v0 act vocabulary; slice 4 registers a `task-extract` runner). */
export type ActRunner = (session: Session, step: WorkflowStep) => Promise<void>

export interface WorkflowExecutorDeps {
  store: WorkspaceRegistry
  docs: WorkflowDocuments
  /** the coalesced distill pass (= distiller.distillChunks). Throws PROPAGATE → the drain re-queues. */
  distill: (chunks: readonly CaptureChunk[], opts: DistillOptions) => Promise<unknown>
  /** the pre-distill transcription stage (= transcribeChunks bound to the stt slot). Throws PROPAGATE. */
  transcribe: (chunks: readonly CaptureChunk[]) => Promise<CaptureChunk[]>
  /** flush pending chunks before the session-end acts (= queue.drainNow) — the drain-first flush. */
  drainNow: () => Promise<void>
  /** act runners by step id; the `follow-up-draft` act = actor.runFollowUpDraft. */
  acts: Record<string, ActRunner>
  log?: (message: string) => void
}

/**
 * Executor v0 — runs a workflow document against the two seams the hardcoded pipeline used: the queue
 * DRAIN (transcribe? → distill → moments/index) and SESSION-END (the follow-up-draft act). With the
 * seeded `workflow-default` document + `workflow.enabled` ON it is behavior-identical to the legacy
 * direct wiring in api/http.ts — same flags honored, same retry-at-idle propagation, same drain-first
 * flush on session end.
 *
 * Reads the active document FRESH per call (the flags/surfaces hot-edit pattern) so a future edit takes
 * effect without a restart. Composes injected capability seams (distill/transcribe/drainNow/acts) rather
 * than importing fabric — pure orchestration over the document, unit-testable with fakes. The
 * focus→detector routing is deliberately NOT a step here (routing context, not pipeline work — it stays
 * in the drain callback in api/http.ts, per the PHASE3 distill-hygiene decision).
 */
export class WorkflowExecutor {
  private readonly log: (message: string) => void
  constructor(private readonly deps: WorkflowExecutorDeps) {
    this.log = deps.log ?? (() => undefined)
  }

  private flagOn(gate?: StepGate): boolean {
    return gate ? isFlagEnabled(this.deps.store, gate.flag) : true
  }

  /**
   * The DRAIN seam. Coalesces the distill-family steps into ONE distill call (the slice-1 seam note):
   * the `distill` step's when-flag gates the WHOLE call; `transcribe` is its pre-stage; `moments`/`index`
   * map to the extract options (each: step present AND its when-flag on). `transcribe`/`distill` throws
   * propagate so the queue re-queues the file (retry-at-idle) and records the classified failure.
   */
  async runDrain(chunks: readonly CaptureChunk[]): Promise<void> {
    const doc = this.deps.docs.active()
    const drainSteps = doc.steps.filter((s) => seamOf(s) === 'drain')
    // Honest handling of kinds with no drain path yet — skip-with-log, never crash (the default doc has
    // none of these on the drain; this is defensive against an edited document).
    for (const step of drainSteps) {
      if (step.kind === 'ocr' || step.kind === 'vlm') {
        this.log(`workflow ${doc.id}: step '${step.id}' (${step.kind}) skipped — no executor path yet (P4B owns invocation)`)
      } else if (step.kind === 'act') {
        this.log(`workflow ${doc.id}: drain-triggered act step '${step.id}' skipped — acts run on session-end in v0`)
      }
    }

    const distillStep = drainSteps.find((s) => s.kind === 'distill')
    // Whole distill-family gate: no distill step, or its flag off → nothing distills, and `transcribe`
    // (its pre-stage) does NOT run standalone. Mirrors the legacy `if (!distill.enabled) return`.
    if (!distillStep || !this.flagOn(distillStep.when)) return

    const transcribeStep = drainSteps.find((s) => s.kind === 'transcribe')
    const momentsStep = drainSteps.find((s) => s.kind === 'moments')
    const indexStep = drainSteps.find((s) => s.kind === 'index')

    const ready =
      transcribeStep && this.flagOn(transcribeStep.when) ? await this.deps.transcribe(chunks) : chunks
    await this.deps.distill(ready, {
      extractMoments: Boolean(momentsStep && this.flagOn(momentsStep.when)),
      extractEntities: Boolean(indexStep && this.flagOn(indexStep.when)),
    })
  }

  /**
   * The SESSION-END seam. Runs the enabled session-end act steps. If NONE are enabled the whole seam is
   * a no-op — no drain, no draft (mirrors the legacy `if (!act.enabled) return`, which never drains when
   * the act is off). Otherwise it flushes the queue first (drainNow) so the acts reflect the whole
   * session, then runs each enabled act in document order. An act step with no registered runner is
   * skipped-with-log (honest, like the unwired drain kinds).
   */
  async runSessionEnd(session: Session): Promise<void> {
    const doc = this.deps.docs.active()
    const enabled = doc.steps.filter(
      (s) => s.kind === 'act' && seamOf(s) === 'session-end' && this.flagOn(s.when),
    )
    if (enabled.length === 0) return
    await this.deps.drainNow()
    for (const step of enabled) {
      const run = this.deps.acts[step.id]
      if (!run) {
        this.log(
          `workflow ${doc.id}: act step '${step.id}' skipped — no runner registered (v0 knows: ${Object.keys(this.deps.acts).join(', ') || 'none'})`,
        )
        continue
      }
      await run(session, step)
    }
  }
}
