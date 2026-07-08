import { Type, type Static } from '@sinclair/typebox'

/**
 * Screen-capture frame contracts (P4B — screen understanding; DESIGN-CRITIQUE §5, ARCHITECTURE §8).
 *
 * A screen frame is an IMAGE, and it rides the EXISTING `CaptureChunk` transport — there is no new
 * screen chunk type. The convention (mirroring how a `source:'focus'` chunk carries decoded JSON):
 *
 *   - `source: 'screen'`
 *   - `encoding: 'base64'`
 *   - `contentType: 'image/png' | 'image/jpeg' | 'image/webp'` (a `ScreenContentType`)
 *   - `data`: the base64-encoded image bytes
 *
 * so the client, spool, and drain need no new transport (same reuse discipline as FocusSignal).
 *
 * WHERE THE FRAME METADATA TRAVELS — the honest decision. A focus chunk can put its whole decoded
 * payload in `data` because a FocusSignal is small JSON. A screen chunk cannot: `data` is occupied by
 * the image bytes, and `CaptureChunk` has no sidecar field (adding one is owned by a parallel session
 * and out of scope here). So a frame's typed descriptor — `ScreenFrameMeta` — travels the SAME way a
 * FocusSignal does, as its OWN `source:'screen'` chunk (`encoding:'utf8'`, `contentType:
 * 'application/json'`, `data` = JSON.stringify(ScreenFrameMeta)), emitted as the companion to the image
 * chunk(s) it describes and correlated by capture order (sequence adjacency). This needs no
 * CaptureChunk change.
 *
 * CRUCIAL for slice 2 (the OCR/VLM invoke path): the meta chunk is provenance ENRICHMENT, not a hard
 * dependency. Everything the invoke path needs to RUN is already on the image `CaptureChunk` — the id,
 * the `contentType`, the base64 `data`, and `capturedAt` — and the pixel dimensions are recoverable
 * from the decoded image itself. So OCR/VLM can run from the image chunk alone; `ScreenFrameMeta`
 * carries the things the bytes do NOT tell you (which display, the backing scale) plus a place for the
 * future Δ-gate to record why a frame was kept. Δ-gating itself is deliberately NOT built here (the
 * `deltaScore` field below is optional and unread until the gate exists).
 */

/** The image encodings a screen frame is captured as — the `contentType` of a `source:'screen'` image chunk. */
export const ScreenContentType = Type.Union(
  ['image/png', 'image/jpeg', 'image/webp'].map((m) => Type.Literal(m)),
  { description: 'mime of a base64 screen frame carried on a CaptureChunk' },
)
export type ScreenContentType = Static<typeof ScreenContentType>

/**
 * The typed descriptor of one screen frame — the FocusSignal-style decoded payload of the companion
 * `source:'screen'` utf8/json chunk (see header). It carries only what the image bytes and the carrying
 * CaptureChunk do NOT already tell you: `capturedAt` lives on the CaptureChunk, so it is not restated
 * here (FocusSignal's no-duplication discipline). `width`/`height` are the pixel coordinate frame that
 * an `OcrResult` block's `region` maps into; `displayId` is which monitor the frame came from (not
 * recoverable from pixels); `scale` is the backing-scale factor so logical↔physical pixels are
 * recoverable on a retina capture. `deltaScore` is the future Δ-gate hook — optional and unread today.
 */
export const ScreenFrameMeta = Type.Object(
  {
    displayId: Type.String({ minLength: 1, description: 'which display/monitor the frame was captured from' }),
    width: Type.Integer({ minimum: 1, description: 'frame pixel width — the coordinate frame OcrResult regions map into' }),
    height: Type.Integer({ minimum: 1, description: 'frame pixel height' }),
    scale: Type.Optional(Type.Number({ minimum: 1, description: 'backing-scale factor (retina); logical px × scale = physical px' })),
    deltaScore: Type.Optional(
      Type.Number({ minimum: 0, maximum: 1, description: 'future Δ-gate: how much this frame changed vs the last kept one — unread until the gate exists' }),
    ),
  },
  { $id: 'ScreenFrameMeta', additionalProperties: false, description: 'decoded descriptor of a source:"screen" frame — travels as its own utf8/json CaptureChunk, not in the image chunk' },
)
export type ScreenFrameMeta = Static<typeof ScreenFrameMeta>
