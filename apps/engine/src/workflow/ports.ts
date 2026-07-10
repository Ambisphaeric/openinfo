import type { WorkflowStepKind } from '@openinfo/contracts'

/**
 * The data-flow signature of one workflow step kind (#121) — what it consumes, what it produces or
 * persists, and what it emits ephemerally, each named by a contract $id (a key of AllSchemas). This is
 * the ports METADATA the workflow-editor arc renders a WorkflowSpec as a typed graph with: a connection
 * between two steps is valid when one's output contract is the other's input contract.
 *
 * - `inputs` — the contract(s) a step consumes. Most kinds consume the drain batch (CaptureChunk); the
 *   `act` kind is trigger-dependent (Session on session-end, CaptureChunk on the drain), so it honestly
 *   names both rather than pretending one.
 * - `outputs` — the contract(s) the step produces/persists (its durable effect on the store/stream).
 * - `emits` — bus-event payloads that are NOT also outputs: the ephemeral fast-path feeds (never
 *   persisted). Only named when they exist, so absence means "this step's events are its outputs".
 *
 * DELIBERATELY DATA-ONLY, and deliberately in engine/workflow (not contracts): it DESCRIBES how the
 * executor's stages map onto the existing contracts — engine knowledge — and adding it changes no
 * schema, route, flag, or behavior. The WorkflowSpec contract's own deferral note ("chained/fan-out
 * nodes force the graph shape later, additively") reserves the seam this table is the precursor to:
 * later editor slices (graph view, connection validation) READ this; the executor never does.
 *
 * TOTALITY is enforced twice: the Record type makes a missing kind a compile error, and ports.test.ts
 * derives the kind list from the WorkflowStepKind schema at runtime — so a future appended kind fails
 * the suite until it declares its ports (the same append-only discipline the union itself documents).
 */
export interface StepPorts {
  /** contract $ids this step consumes (AllSchemas keys). */
  inputs: readonly string[]
  /** contract $ids this step produces/persists (AllSchemas keys). */
  outputs: readonly string[]
  /** contract $ids of EPHEMERAL bus payloads (never persisted) — only the ones that are not outputs. */
  emits?: readonly string[]
  /** one honest sentence: what flows in, what comes out, where it runs. */
  description: string
}

export const STEP_PORTS: Record<WorkflowStepKind, StepPorts> = {
  transcribe: {
    inputs: ['CaptureChunk'],
    outputs: ['CaptureChunk'],
    emits: ['TranscriptUpdate'],
    description:
      'stt stage on the audio drain track (#115): audio/* base64 chunks are rewritten as utf8 text chunks (source preserved); each success emits the ephemeral live transcript.updated fast-path (#58).',
  },
  ocr: {
    inputs: ['CaptureChunk'],
    outputs: ['OcrResult', 'Distillate'],
    description:
      'screen understanding over the ocr slot: consumes screen frames from the drain batch, persists an OcrResult + a distillate per recognized frame (real drain work — throws re-queue).',
  },
  vlm: {
    inputs: ['CaptureChunk'],
    outputs: ['OcrResult', 'Distillate'],
    description:
      'screen understanding over the vlm slot (prompted recognition, params carry the prompt): same consumes/persists shape as ocr.',
  },
  distill: {
    inputs: ['CaptureChunk'],
    outputs: ['Distillate'],
    description:
      'the rolling-merge distiller on the text drain track, cadence-gated (#58): utf8 chunks in, one distillate per released window out.',
  },
  moments: {
    inputs: ['CaptureChunk'],
    outputs: ['Moment'],
    description:
      'typed-moment extraction riding the distill pass: the same released batch in, zero-or-more persisted moments out.',
  },
  index: {
    inputs: ['CaptureChunk'],
    outputs: ['Entity'],
    description:
      'entity extraction + recency×frequency indexing riding the distill pass: the same released batch in, upserted entities out.',
  },
  act: {
    inputs: ['Session', 'CaptureChunk'],
    outputs: ['Draft', 'TodoList'],
    description:
      'an Act, trigger-dependent: session-end acts consume the ended Session (follow-up-draft → Draft); drain acts consume the drained batch (task-extract → TodoList).',
  },
}
