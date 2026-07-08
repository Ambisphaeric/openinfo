import type { CaptureChunk, CaptureSource } from '@openinfo/contracts'
import type { SttAudio, SttOptions, SttResult } from '../fabric/index.js'

/** Injected stt invoker (defaults to the fabric stt slot in the wiring; tests pass a fake). */
export type SttInvoke = (audio: SttAudio, opts?: SttOptions) => Promise<SttResult>

export interface TranscribeDeps {
  invoke: SttInvoke
  /** optional ISO-639-1 hint forwarded to the transcriber */
  language?: string
  log?: (message: string) => void
}

/**
 * How audio is identified: a base64 chunk whose contentType is an `audio/*` MIME. This is the shape
 * the client capture slice emits for mic/system-audio (e.g. `audio/wav`, `audio/webm`). base64 chunks
 * with a non-audio contentType (screen frames — `image/*`) are NOT audio and pass through untouched
 * (OCR is P3). utf8 chunks are already text and are never transcribed.
 */
export const isAudioChunk = (chunk: CaptureChunk): boolean =>
  chunk.encoding === 'base64' && chunk.contentType.toLowerCase().startsWith('audio/')

/**
 * Speaker attribution for free, from the capture source: the local mic is the user ("me"); loopback
 * system-audio is the far side of the call ("them"). Any other source (screen/calendar/repo/camera)
 * has no speaker in v0. This is NOT diarization — it is the physical capture split, so it costs
 * nothing. The distiller prefixes each transcript line with this label so both the summary and the
 * moment/entity extraction prompts can attribute; the moments extractor echoes it into Moment.speaker
 * when the model emits one (Moment.speaker is "person entity id or raw label" — 'me'/'them' is a raw
 * label until voice→person identity lands, which is P7).
 */
export const speakerLabel = (source: CaptureSource): 'me' | 'them' | undefined =>
  source === 'mic' ? 'me' : source === 'system-audio' ? 'them' : undefined

/**
 * The pre-distill transcription stage. Audio chunks are transcribed via the `stt` slot and rewritten
 * as utf8 text chunks (source PRESERVED, so the speaker split survives into the distiller); non-audio
 * chunks pass through untouched. Runs BEFORE the distiller's utf8 filter, so transcribed audio then
 * flows through the ordinary distill pass.
 *
 * - Silence (an empty '' transcript) is a normal zero-text outcome: the chunk yields no text chunk
 *   (dropped), NOT an error.
 * - Transport/protocol failures from `invoke` PROPAGATE (never swallowed) so the drain re-queues the
 *   spool file — the same retry-at-idle the distill/moments stages rely on. Nothing is lost: the raw
 *   audio stays durably spooled until a later drain transcribes it.
 */
export const transcribeChunks = async (chunks: readonly CaptureChunk[], deps: TranscribeDeps): Promise<CaptureChunk[]> => {
  const log = deps.log ?? (() => undefined)
  const out: CaptureChunk[] = []
  for (const chunk of chunks) {
    if (!isAudioChunk(chunk)) {
      out.push(chunk)
      continue
    }
    const result = await deps.invoke(
      { base64: chunk.data, contentType: chunk.contentType },
      deps.language !== undefined ? { language: deps.language } : {},
    )
    const text = result.text.trim()
    if (text.length === 0) {
      log(`transcribe: silence in ${chunk.source} chunk ${chunk.id} (${result.endpoint}), no text emitted`)
      continue
    }
    out.push({ ...chunk, encoding: 'utf8', contentType: 'text/plain', data: text })
    log(`transcribe: ${chunk.source} chunk ${chunk.id} → ${text.length} chars via ${result.endpoint}`)
  }
  return out
}
