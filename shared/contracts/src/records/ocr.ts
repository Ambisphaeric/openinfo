import { Type, type Static } from '@sinclair/typebox'
import { Id, IsoTime, Confidence, InvokeUsage } from '../common.js'
import { EgressDecision } from '../config/egress.js'

/**
 * The output of one screen-understanding pass — the OCR/VLM analogue of a Distillate (P4B;
 * DESIGN-CRITIQUE §5). One or more `source:'screen'` CaptureChunks (the frames) go in; recognized text
 * comes out, persisted to the session's workspace DB with model/endpoint provenance so nothing surfaces
 * without a one-line why (product principle 1). Raw frames expire once understood, exactly as raw
 * transcript chunks expire once distilled — the queue "deletes raw after distillation either way"
 * (DESIGN-CRITIQUE §5).
 *
 * It mirrors Distillate's envelope (id/sessionId/workspaceId/sourceChunks/text/provenance/
 * schemaVersion/createdAt) and adds ONLY what a text summary does not carry: the `slot` is constrained
 * to the two screen-understanding slots (`ocr` | `vlm`), and an OPTIONAL `blocks` array carries the
 * per-region boxes+confidence a PaddleOCR-class runtime returns. A VLM produces prose — it fills `text`
 * and leaves `blocks` absent; an OCR engine fills both (`text` is the flattened join of `blocks`). So a
 * consumer reads `text` uniformly regardless of which slot ran, and `blocks` is present only when the
 * runtime is region-aware.
 */
export const OCR_RESULT_SCHEMA_VERSION = 1

/** The screen-understanding slots — the two SlotName members that produce an OcrResult. */
const OcrSlot = Type.Union([Type.Literal('ocr'), Type.Literal('vlm')], {
  description: 'which capability slot produced this — a subset of SlotName',
})

/**
 * One recognized region — a PaddleOCR-class box. `region` is the bounding box in the frame's PIXEL
 * coordinates (the frame ScreenFrameMeta.width/height define). Absent from a VLM result (prose has no
 * boxes). All optional beyond `text` so a runtime that returns text without geometry still validates.
 */
const OcrBlock = Type.Object(
  {
    text: Type.String({ description: 'the recognized text of this region' }),
    confidence: Type.Optional(Confidence),
    region: Type.Optional(
      Type.Object(
        {
          x: Type.Integer({ minimum: 0 }),
          y: Type.Integer({ minimum: 0 }),
          width: Type.Integer({ minimum: 1 }),
          height: Type.Integer({ minimum: 1 }),
        },
        { additionalProperties: false, description: 'bounding box in the frame pixel coordinate space' },
      ),
    ),
  },
  { additionalProperties: false },
)

export const OcrResult = Type.Object(
  {
    id: Id,
    sessionId: Id,
    workspaceId: Id,
    sourceChunks: Type.Array(Id, { description: 'screen CaptureChunk ids understood in this pass' }),
    // #116: the correlation id of the screen-understanding pass — shared with the mirror Distillate the
    // same pass persists, so the pair reads as ONE pass. Append-only/optional: records predating #116 omit it.
    spanId: Type.Optional(Id),
    text: Type.String({ description: 'the recognized text — flattened join of blocks (ocr) or the VLM prose' }),
    blocks: Type.Optional(
      Type.Array(OcrBlock, { description: 'per-region boxes+confidence; present for a region-aware (ocr) runtime, absent for a vlm' }),
    ),
    provenance: Type.Object(
      {
        slot: OcrSlot,
        endpoint: Type.String({ minLength: 1, description: 'fabric endpoint name that produced this' }),
        model: Type.Optional(Type.String()),
        usage: Type.Optional(InvokeUsage),
        // #64/#196: screen-derived content denies HOSTED/PUBLIC egress. A successful invoke is either
        // device-local or an explicitly trusted LAN raw-frame hop; the optional additive destination /
        // rawFrameTrust detail on EgressDecision distinguishes those without exposing a URL or payload.
        egress: Type.Optional(EgressDecision),
      },
      { additionalProperties: false },
    ),
    schemaVersion: Type.Integer({ minimum: 1 }),
    createdAt: IsoTime,
    /**
     * The TRUE capture instant of the recognized frame (#102 "keep time") — threaded from the source
     * `CaptureChunk.capturedAt`, so the record itself carries when the screen was seen, distinct from
     * `createdAt` (when recognition finished). Until now only the mirror Distillate's windowStart/End
     * preserved it, so a direct OcrResult consumer saw processing time and could present delayed OCR as
     * real-time. Append-only/optional: pre-existing records without it still validate (their capture time
     * is simply unknown on the record — the mirror Distillate remains the fallback).
     */
    capturedAt: Type.Optional(IsoTime),
  },
  { $id: 'OcrResult', additionalProperties: false },
)
export type OcrResult = Static<typeof OcrResult>
