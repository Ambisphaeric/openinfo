import type { CaptureChunk, CaptureSource, TranscriptUpdate } from '@openinfo/contracts'
import { dropSilentSegments, DEFAULT_NO_SPEECH_THRESHOLD, type SttAudio, type SttOptions, type SttResult } from '../fabric/index.js'

/** Injected stt invoker (defaults to the fabric stt slot in the wiring; tests pass a fake). */
export type SttInvoke = (audio: SttAudio, opts?: SttOptions) => Promise<SttResult>

export interface TranscribeDeps {
  invoke: SttInvoke
  /** optional ISO-639-1 hint forwarded to the transcriber */
  language?: string
  /** Wall clock used to stamp successful STT completion. Injected only for deterministic tests. */
  now?: () => string
  /**
   * Fired per successfully-transcribed AUDIO chunk (silence and non-audio passthrough never fire). The
   * ORIGINAL chunk (its sessionId/source/capturedAt) plus the transcript text — the transcript fast-path
   * hook (#58). transcribeChunks stays pure of the bus; the wiring aggregates these into TranscriptUpdate
   * events. Never throws into the transcribe loop (the wiring keeps it side-effect-only).
   */
  onTranscribed?: (chunk: CaptureChunk, text: string, processedAt: string) => void
  /**
   * No-speech probability (0..1) at/above which a whisper-class segment is dropped as silence before it
   * can enter the distill accumulator (#69). Defaults to DEFAULT_NO_SPEECH_THRESHOLD (0.8). Configurable
   * so the wiring can tune it (e.g. from an env override) without editing this stage.
   */
  noSpeechThreshold?: number
  /**
   * Accounting hook for the silence filter (#69): fired for every audio chunk from which one or more
   * segments were dropped as no-speech / hallucination — `windowSkipped` is true when NOTHING survived
   * (the whole window contributes no text and emits no transcript.updated event). The wiring aggregates
   * these into a skipped-as-silence count so filtered windows are visible, never silently vanished.
   */
  onSilenceSkipped?: (chunk: CaptureChunk, info: { dropped: number; total: number; windowSkipped: boolean }) => void
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
 * A physical audio-lane label, not speaker identity. A microphone can hear several nearby people and
 * system audio can contain several remote speakers/media sources; same-mic diarization belongs to #137.
 * Engine prompts use these labels so source survives distill/fields/judge without inventing “me/them”.
 */
export const captureLaneLabel = (source: CaptureSource): 'microphone' | 'system audio' | undefined =>
  source === 'mic' ? 'microphone' : source === 'system-audio' ? 'system audio' : undefined

/** @deprecated Use captureLaneLabel; retained as an additive import alias with physical-lane semantics. */
export const speakerLabel = captureLaneLabel

/**
 * The pre-distill transcription stage. Audio chunks are transcribed via the `stt` slot and rewritten
 * as utf8 text chunks (source PRESERVED, so physical lanes survive into the distiller); non-audio
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
    // Silence filter (#69): drop no-speech/hallucinated segments BEFORE the text enters the accumulator.
    // For whisper-class flavors this reads each segment's no_speech_prob; for flavors with no such signal
    // it only drops empty/whitespace segments (and plain {text} responses pass through). `text` is the
    // transcript rebuilt from the surviving speech segments.
    const filtered = dropSilentSegments(result, deps.noSpeechThreshold ?? DEFAULT_NO_SPEECH_THRESHOLD)
    const text = filtered.text
    if (text.length === 0) {
      // A fully-silent window: either the transcript was empty ('' silence) or EVERY segment was dropped
      // as no-speech. Either way it contributes NOTHING — no text chunk, and (crucially) no onTranscribed
      // call, so a hallucinated phrase never reaches the live transcript strip. A filtered-to-nothing
      // window is accounted as skipped-as-silence; a plainly-empty one keeps the existing silence log.
      if (filtered.dropped > 0) {
        deps.onSilenceSkipped?.(chunk, { dropped: filtered.dropped, total: filtered.total, windowSkipped: true })
        log(`transcribe: ${chunk.source} chunk ${chunk.id} filtered as silence — dropped ${filtered.dropped}/${filtered.total} no-speech segment(s) (${result.endpoint}), no text emitted`)
      } else {
        log(`transcribe: silence in ${chunk.source} chunk ${chunk.id} (${result.endpoint}), no text emitted`)
      }
      continue
    }
    // Partial filtering: some no-speech segments were dropped but real speech survived — account the drop
    // (visible, not vanished) and emit only the surviving text.
    if (filtered.dropped > 0) {
      deps.onSilenceSkipped?.(chunk, { dropped: filtered.dropped, total: filtered.total, windowSkipped: false })
      log(`transcribe: dropped ${filtered.dropped}/${filtered.total} no-speech segment(s) from ${chunk.source} chunk ${chunk.id} (${result.endpoint})`)
    }
    out.push({ ...chunk, encoding: 'utf8', contentType: 'text/plain', data: text })
    // Stamp the actual completion boundary, after STT + silence filtering succeeded and immediately
    // before the transcript outcome leaves this stage. The caller threads this value into the public
    // TranscriptUpdate; it must never guess a processing time from capturedAt.
    const processedAt = (deps.now ?? (() => new Date().toISOString()))()
    deps.onTranscribed?.(chunk, text, processedAt)
    log(`transcribe: ${chunk.source} chunk ${chunk.id} → ${text.length} chars via ${result.endpoint}`)
  }
  return out
}

/**
 * Aggregate per-chunk transcription outcomes into ephemeral TranscriptUpdate events (#58): one update
 * per CONTIGUOUS (sessionId, source) run in true capture order. Contiguous aggregation keeps adjacent
 * same-lane chunks compact without destroying cross-lane chronology: mic(t0), system(t1), mic(t2) stays
 * three ordered updates, never the false mic(t0+t2), system(t1) shape. At equal capture timestamps true
 * cross-lane order is unknown (lane sequences are not global), so stable session/source keys decide only
 * a deterministic presentation order; `sequence` orders chunks within that same physical source.
 *
 * `sourceChunkIds` carries the exact input ids in run order; `sourceSequenceRange` carries the true
 * source-local sequence span (not a cross-lane clock); `capturedAtRange` is their min→max capture span;
 * `processedAt` is the latest REAL completion stamp supplied by transcribeChunks. Pure — the wiring
 * publishes the result on the bus. NOT persisted.
 */
export interface TranscribedSegment {
  sourceChunkId: string
  sessionId: string
  source: CaptureSource
  sequence: number
  text: string
  capturedAt: string
  processedAt: string
}

const compareSegments = (a: TranscribedSegment, b: TranscribedSegment): number =>
  a.capturedAt.localeCompare(b.capturedAt) ||
  a.sessionId.localeCompare(b.sessionId) ||
  a.source.localeCompare(b.source) ||
  a.sequence - b.sequence ||
  a.sourceChunkId.localeCompare(b.sourceChunkId) ||
  a.processedAt.localeCompare(b.processedAt)

export const buildTranscriptUpdates = (
  segments: readonly TranscribedSegment[],
): TranscriptUpdate[] => {
  const ordered = [...segments].sort(compareSegments)
  const groups: Array<{
    sessionId: string
    source: CaptureSource
    texts: string[]
    sourceChunkIds: string[]
    sequenceStart: number
    sequenceEnd: number
    start: string
    end: string
    processedAt: string
  }> = []

  for (const seg of ordered) {
    const existing = groups.at(-1)
    if (existing !== undefined && existing.sessionId === seg.sessionId && existing.source === seg.source) {
      existing.texts.push(seg.text)
      existing.sourceChunkIds.push(seg.sourceChunkId)
      if (seg.sequence < existing.sequenceStart) existing.sequenceStart = seg.sequence
      if (seg.sequence > existing.sequenceEnd) existing.sequenceEnd = seg.sequence
      if (seg.capturedAt < existing.start) existing.start = seg.capturedAt
      if (seg.capturedAt > existing.end) existing.end = seg.capturedAt
      if (seg.processedAt > existing.processedAt) existing.processedAt = seg.processedAt
      continue
    }
    groups.push({
      sessionId: seg.sessionId,
      source: seg.source,
      texts: [seg.text],
      sourceChunkIds: [seg.sourceChunkId],
      sequenceStart: seg.sequence,
      sequenceEnd: seg.sequence,
      start: seg.capturedAt,
      end: seg.capturedAt,
      processedAt: seg.processedAt,
    })
  }

  return groups.map((group) => ({
    sessionId: group.sessionId,
    source: group.source,
    text: group.texts.join(' '),
    sourceChunkIds: group.sourceChunkIds,
    sourceSequenceRange: { start: group.sequenceStart, end: group.sequenceEnd },
    capturedAtRange: { start: group.start, end: group.end },
    processedAt: group.processedAt,
  }))
}
