import type { CaptureChunk, QueueKindDepth } from '@openinfo/contracts'

/**
 * The work kinds as a PRECISE literal union. The contract's `QueueKind` Static-infers as bare `string`
 * (the union-of-literals `.map` quirk — see workflow/executor.ts's `seamOf` note), so the executor-side
 * code carries its own exact type; `WorkKind` is the wire union `QueueKind` pinned to its literals here.
 */
export type WorkKind = 'audio' | 'screen' | 'llm-work'

/**
 * Typed queues (P4A slice 3). Classify a spooled chunk into a work KIND from its `source`/`contentType`
 * alone — the queue never imports a capture producer, so P4B's screen chunks land in the `screen` kind
 * (a `screen`/`camera` source or an `image/*` contentType) without the queue knowing anything about P4B.
 *
 * - `audio`    — mic / system-audio (the me/them split), or any `audio/*` payload
 * - `screen`   — screen / camera frames, or any `image/*` payload (P4B adds the producers)
 * - `llm-work` — text/utf8 work destined for distill (calendar / repo / typed text — the default)
 * - `focus`    — NOT a work kind: `source: 'focus'` chunks are ephemeral routing context (consumed by
 *                the detector, never distilled), so they are EXCLUDED from per-kind depth and the ETA.
 */
export type ChunkKind = WorkKind | 'focus'

export function classifyKind(chunk: CaptureChunk): ChunkKind {
  if (chunk.source === 'focus') return 'focus'
  const contentType = chunk.contentType.toLowerCase()
  if (chunk.source === 'mic' || chunk.source === 'system-audio' || contentType.startsWith('audio/')) {
    return 'audio'
  }
  if (chunk.source === 'screen' || chunk.source === 'camera' || contentType.startsWith('image/')) {
    return 'screen'
  }
  return 'llm-work'
}

/** The three work kinds, in a stable order (focus is excluded — it never backlogs). */
export const WORK_KINDS: readonly WorkKind[] = ['audio', 'screen', 'llm-work']

export interface ByKind {
  audio: QueueKindDepth
  screen: QueueKindDepth
  'llm-work': QueueKindDepth
}

const emptyByKind = (): ByKind => ({
  audio: { pendingChunks: 0, pendingBytes: 0 },
  screen: { pendingChunks: 0, pendingBytes: 0 },
  'llm-work': { pendingChunks: 0, pendingBytes: 0 },
})

/**
 * Tally the pending chunks of ONE spooled file into per-kind depth. `fileBytes` is the file's on-disk
 * size; it is apportioned across the kinds present PROPORTIONALLY to each kind's chunk count, so the
 * per-kind byte figures sum to the work-chunk share of the file (focus chunks are counted toward the
 * proportion's denominator so their bytes are NOT attributed to a work kind — they are dropped from the
 * per-kind totals, which is why byKind byte sums can be less than the file's size). A file with no work
 * chunks (e.g. focus-only) contributes zero to every kind.
 */
export function tallyFile(chunks: readonly CaptureChunk[], fileBytes: number, into: ByKind = emptyByKind()): ByKind {
  if (chunks.length === 0) return into
  const bytesPerChunk = fileBytes / chunks.length
  for (const chunk of chunks) {
    const kind = classifyKind(chunk)
    if (kind === 'focus') continue
    into[kind].pendingChunks += 1
    into[kind].pendingBytes += Math.round(bytesPerChunk)
  }
  return into
}

export { emptyByKind }
