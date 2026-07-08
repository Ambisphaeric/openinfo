import { Type, type Static } from '@sinclair/typebox'
import { ScreenContentType } from '../records/screen.js'

/**
 * Screen-understanding INVOKE params (P4B; DESIGN-CRITIQUE §5, ARCHITECTURE §8) — the typed request the
 * engine's `invokeOcr` / `invokeVlm` (slice 2) implement, and the params a workflow `ocr`/`vlm` step
 * (P4A) carries. They are the invoke-time contract for the `ocr` and `vlm` fabric slots, the sibling of
 * the discovery `ScanRequest`/`ScanResult` params (the fabric's request shapes live next to the
 * capability they drive).
 *
 * Engine-AGNOSTIC by design: they name WHAT to understand (an image + how it is encoded, plus a VLM
 * prompt), never WHICH endpoint runs it — slot→endpoint resolution and fallback order are the fabric's
 * job (§8: "modes and blocks reference slots by name, never a vendor"). The image travels the same way
 * it rides a screen CaptureChunk — base64 with a `ScreenContentType` mime (reused from the screen
 * record, not re-declared) — so a step can invoke straight from a `source:'screen'` chunk's
 * `data`/`contentType`.
 *
 * RESULT SHAPE — already covered, deliberately no new type. What these produce is recognized text
 * (plus per-region boxes+confidence for a PaddleOCR-class runtime); that is exactly `OcrResult`'s
 * non-envelope body. The engine wraps the recognized content into an `OcrResult`, stamping the envelope
 * it owns (id/sessionId/workspaceId/sourceChunks/provenance/createdAt). So `invokeOcr`/`invokeVlm`
 * return an `OcrResult` — these modules add only the request side.
 */

/**
 * Params for the `ocr` slot — pure recognition (PaddleOCR-class; fast, CPU-viable, region-aware). No
 * prompt: OCR reads whatever text is in the frame. `timeoutMs` is optional (the slot/endpoint carries a
 * default); a caller sets it to bound a deferred queue pass.
 */
export const OcrInvokeParams = Type.Object(
  {
    image: Type.String({ minLength: 1, description: 'the frame as a base64-encoded image (same bytes a source:"screen" CaptureChunk carries)' }),
    contentType: ScreenContentType,
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: 'bound the invoke; falls back to the endpoint default when absent' })),
  },
  { $id: 'OcrInvokeParams', additionalProperties: false },
)
export type OcrInvokeParams = Static<typeof OcrInvokeParams>

/**
 * Params for the `vlm` slot — richer, heavier vision-language understanding. Same image transport as
 * OCR, plus the `prompt` that steers what the model reports (e.g. "summarize this screen", "read the
 * error dialog"). Produces prose (an `OcrResult` with `text` and no `blocks`).
 */
export const VlmInvokeParams = Type.Object(
  {
    image: Type.String({ minLength: 1, description: 'the frame as a base64-encoded image (same bytes a source:"screen" CaptureChunk carries)' }),
    contentType: ScreenContentType,
    prompt: Type.String({ minLength: 1, description: 'the instruction steering what the VLM reports about the frame' }),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: 'bound the invoke; falls back to the endpoint default when absent' })),
  },
  { $id: 'VlmInvokeParams', additionalProperties: false },
)
export type VlmInvokeParams = Static<typeof VlmInvokeParams>
