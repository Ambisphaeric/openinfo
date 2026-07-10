import type { TranscriptUpdate } from '@openinfo/contracts'

/**
 * How many recent transcript updates the ring retains for the running process. Small on purpose: the
 * inspector is a live debugging glance at the RECENT feed, not a log. Disclosed as `ringLimit` in the
 * TranscriptInspector snapshot so the surface can honestly say "last N".
 */
export const DEFAULT_TRANSCRIPT_RING_SIZE = 50

/**
 * An in-memory ring of the most recent ephemeral TranscriptUpdates (#101) — the honest v0 source behind the
 * diagnostics app's transcription inspector. It mirrors the queue's operational-state pattern (spool.ts):
 * NOT a store record, NOT persisted, held only in memory and cleared on restart. Fed off the
 * `transcript.updated` bus (the same ephemeral fast-path the HUD's live strip renders, #58), so it never
 * introduces a new persistence path for raw transcripts — it only remembers the last few that flew past.
 *
 * The ring bounds itself to `limit` entries (oldest dropped), so a long session never grows it unbounded.
 * `recent()` returns them NEWEST-FIRST — the order the inspector renders.
 */
export class TranscriptRing {
  private readonly items: TranscriptUpdate[] = []

  constructor(private readonly limit: number = DEFAULT_TRANSCRIPT_RING_SIZE) {}

  /** Remember one update, evicting the oldest once the ring is full. */
  record(update: TranscriptUpdate): void {
    this.items.push(update)
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit)
  }

  /** The retained updates, newest-first (the inspector's render order). A fresh copy — never the backing array. */
  recent(): TranscriptUpdate[] {
    return [...this.items].reverse()
  }

  /** The retention bound, surfaced as the inspector's `ringLimit` disclosure. */
  get capacity(): number {
    return this.limit
  }
}
