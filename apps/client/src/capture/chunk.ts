import type { CaptureChunk } from '@openinfo/contracts'
import type { RawSegment } from './protocol.js'

/**
 * Turning a raw mic segment into a CaptureChunk — the pure assembly step, so sequence numbering,
 * base64 wrapping, and contentType normalization are asserted headless (no electron, no window). The
 * main process calls this on each `mic:segment` and hands the result to EngineLink.capture, which
 * POSTs it to `/capture/mic` or spools it offline (unchanged Phase-1 seam). Speaker attribution is
 * free downstream: `source: 'mic'` is the user ("me") per the engine's transcribe slice.
 */

/** The session a capture run belongs to — the two ids the renderer doesn't know (main owns them). */
export interface CaptureContext {
  sessionId: string
  workspaceId: string
}

/** MediaRecorder's native container. The engine sniffs `audio/webm` → `audio.webm` for the STT multipart. */
export const DEFAULT_AUDIO_CONTENT_TYPE = 'audio/webm'

/**
 * Normalize a MediaRecorder MIME to the bare `audio/<subtype>` the engine's STT filename sniff expects
 * (it splits on `;`, so `audio/webm;codecs=opus` and `audio/webm` map to the same `audio.webm`). A
 * missing or non-audio MIME falls back to the default rather than emitting something distill can't route.
 */
export const normalizeContentType = (mimeType: string): string => {
  const base = mimeType.split(';')[0]?.trim().toLowerCase() ?? ''
  return base.startsWith('audio/') && base.length > 'audio/'.length ? base : DEFAULT_AUDIO_CONTENT_TYPE
}

/** base64 of the raw container bytes — CaptureChunk carries audio as `encoding: 'base64'`. */
const toBase64 = (bytes: ArrayBuffer): string => Buffer.from(new Uint8Array(bytes)).toString('base64')

const pad = (value: number): string => String(value).padStart(6, '0')

/**
 * Build the CaptureChunk for one segment. `sequence` is a monotonic per-run counter the caller owns
 * (starting at 1), so chunks within a session order deterministically; the id folds in the session id
 * and the padded sequence so it is stable and collision-free across a run.
 */
export const segmentToChunk = (segment: RawSegment, context: CaptureContext, sequence: number): CaptureChunk => ({
  id: `mic-${context.sessionId}-${pad(sequence)}`,
  sessionId: context.sessionId,
  workspaceId: context.workspaceId,
  source: 'mic',
  sequence,
  capturedAt: segment.capturedAt,
  contentType: normalizeContentType(segment.mimeType),
  encoding: 'base64',
  data: toBase64(segment.bytes),
})
