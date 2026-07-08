import type { CaptureChunk } from '@openinfo/contracts'
import type { CaptureSourceKind, RawSegment } from './protocol.js'

/**
 * Turning a raw audio segment into a CaptureChunk — the pure assembly step, so sequence numbering,
 * base64 wrapping, and contentType normalization are asserted headless (no electron, no window). The
 * main process calls this on each `capture:segment` and hands the result to EngineLink.capture, which
 * POSTs it to `/capture/<source>` or spools it offline (unchanged Phase-1 seam). Speaker attribution is
 * free downstream: `source: 'mic'` is the user ("me"), `source: 'system-audio'` is the far side of a
 * call ("them"), per the engine's transcribe slice — no diarization, just the source split.
 */

/** The session a capture run belongs to — the two ids the renderer doesn't know (main owns them). */
export interface CaptureContext {
  sessionId: string
  workspaceId: string
}

/** MediaRecorder's native container. The engine sniffs `audio/webm` → `audio.webm` for the STT multipart. */
export const DEFAULT_AUDIO_CONTENT_TYPE = 'audio/webm'

/** The image encoding a screen frame is captured as (chunk.ts encodes JPEG — see the main-process grab). */
export const DEFAULT_SCREEN_CONTENT_TYPE = 'image/jpeg'

/** The contentType of the companion ScreenFrameMeta chunk — decoded JSON, exactly like a FocusSignal chunk. */
export const SCREEN_META_CONTENT_TYPE = 'application/json'

/**
 * The chunk-id prefix per source — folded into the id so ids (and thus the offline-spool filenames)
 * are stable, human-readable, and **collision-free across sources**: each source's run carries its own
 * monotonic sequence, but `mic-…`, `sys-…`, and `scr-…` ids never collide even at the same sequence
 * number. Kept short to stay readable in logs/spool names. A screen frame AND its companion metadata
 * chunk BOTH use the `scr` prefix (they are two `source:'screen'` chunks) — they stay unique because the
 * controller advances the sequence for each, so the image is `scr-…-000001` and its meta `scr-…-000002`.
 */
const ID_PREFIX: Record<CaptureSourceKind, string> = { mic: 'mic', 'system-audio': 'sys', screen: 'scr' }

/**
 * Normalize a MediaRecorder MIME to the bare `audio/<subtype>` the engine's STT filename sniff expects
 * (it splits on `;`, so `audio/webm;codecs=opus` and `audio/webm` map to the same `audio.webm`). A
 * missing or non-audio MIME falls back to the default rather than emitting something distill can't route.
 */
export const normalizeContentType = (mimeType: string): string => {
  const base = mimeType.split(';')[0]?.trim().toLowerCase() ?? ''
  return base.startsWith('audio/') && base.length > 'audio/'.length ? base : DEFAULT_AUDIO_CONTENT_TYPE
}

/**
 * Normalize a screen frame's MIME to a bare `image/<subtype>` (a ScreenContentType — records/screen.ts).
 * Mirrors normalizeContentType but for images: strips any `;`-params and lowercases, and a missing or
 * non-image MIME falls back to `image/jpeg` (what the main-process grab actually encodes).
 */
export const normalizeScreenContentType = (mimeType: string): string => {
  const base = mimeType.split(';')[0]?.trim().toLowerCase() ?? ''
  return base.startsWith('image/') && base.length > 'image/'.length ? base : DEFAULT_SCREEN_CONTENT_TYPE
}

/** base64 of the raw container bytes — CaptureChunk carries audio as `encoding: 'base64'`. */
const toBase64 = (bytes: ArrayBuffer): string => Buffer.from(new Uint8Array(bytes)).toString('base64')

const pad = (value: number): string => String(value).padStart(6, '0')

/**
 * Build the CaptureChunk for one segment. `sequence` is a monotonic per-run counter the caller owns
 * (starting at 1), so chunks within a session order deterministically; the id folds in the source
 * prefix, the session id, and the padded sequence so it is stable and collision-free across a run (and
 * across sources). `source` comes off the segment — the renderer stamps it — and rides straight through
 * to the CaptureChunk the engine attributes me/them by.
 */
export const segmentToChunk = (segment: RawSegment, context: CaptureContext, sequence: number): CaptureChunk => ({
  id: `${ID_PREFIX[segment.source]}-${context.sessionId}-${pad(sequence)}`,
  sessionId: context.sessionId,
  workspaceId: context.workspaceId,
  source: segment.source,
  sequence,
  capturedAt: segment.capturedAt,
  // Screen frames are images (image/<subtype>); audio uses the STT-sniff audio normalizer. Both are
  // base64 container/pixel bytes on the same CaptureChunk transport (records/screen.ts reuse discipline).
  contentType: segment.source === 'screen' ? normalizeScreenContentType(segment.mimeType) : normalizeContentType(segment.mimeType),
  encoding: 'base64',
  data: toBase64(segment.bytes),
})

/**
 * Build the companion ScreenFrameMeta CaptureChunk for a screen frame — its typed descriptor (which
 * display, pixel dimensions, backing scale) travelling exactly the way a FocusSignal does: its OWN
 * `source:'screen'` chunk with `encoding:'utf8'`, `contentType:'application/json'`, and `data` =
 * JSON.stringify(ScreenFrameMeta) (records/screen.ts). The caller emits it adjacent to the image chunk it
 * describes, at the NEXT sequence number, so the two correlate by capture order. `capturedAt` matches the
 * image chunk's (it is the frame's grab time) — the meta does NOT restate it as a payload field
 * (FocusSignal's no-duplication discipline; it already lives on the CaptureChunk).
 */
export const frameMetaToChunk = (segment: RawSegment, context: CaptureContext, sequence: number): CaptureChunk => {
  if (!segment.screenMeta) throw new Error('frameMetaToChunk called on a segment without screenMeta')
  return {
    id: `${ID_PREFIX[segment.source]}-${context.sessionId}-${pad(sequence)}`,
    sessionId: context.sessionId,
    workspaceId: context.workspaceId,
    source: segment.source,
    sequence,
    capturedAt: segment.capturedAt,
    contentType: SCREEN_META_CONTENT_TYPE,
    encoding: 'utf8',
    data: JSON.stringify(segment.screenMeta),
  }
}
