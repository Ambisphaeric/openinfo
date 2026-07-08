# engine/queue — Phase 1 (v0 spool/drain), P4A slice 3 (typed queues + envelope/ETA)
- `spool.ts` (P1) — never lose capture; process at idle in session order. The drain records per-file rate
  samples (work-chunks over processor ms) for the ETA, and `status()` tallies per-kind depth by parsing the
  pending files. Durability (append/drain/re-queue-on-failure) is untouched.
- `kinds.ts` (P4A-s3) — classify a spooled chunk into a work kind (`audio` = mic/system-audio, `screen` =
  screen/camera or image/*, `llm-work` = text destined for distill) from `source`/`contentType` ALONE, so
  P4B's screen chunks land in `screen` without the queue importing P4B. `focus` chunks are excluded — they
  are ephemeral routing context (consumed by the detector, never a backlog).
- `eta.ts` (P4A-s3) — pure drain-rate projection ("caught up by 6:40p") from observed drain samples. HONEST:
  `basis: 'none'` with no fabricated ETA when there is no data; measured tok/s (fabric §8) is echoed as the
  envelope's measured side, not (in v0) itself the ETA basis. Overall, not per-kind (the drain is file-granular).
- `GET /queue` (`QueueStatus`) surfaces additive `byKind` / `eta` / `overflow`. `overflow.policy` is the active
  mode's declared intent; only `queue-for-idle` is `enforced` in v0 (degrade-cadence is client-side, drop would
  break never-lose-capture — both declared-but-inert). The measured-tok/s + overflow inputs are injected from
  `api/http.ts` as read-only seams, so the queue keeps zero fabric/store imports.
- `gc.ts` (planned) — raw deleted the moment its session is distilled
