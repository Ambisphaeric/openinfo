# engine/queue — Phase 1 (v0 spool/drain), Phase 3 (envelope/ETA)
- `spool.ts` + `drain.ts` (P1) — never lose capture; process at idle in session order
- `eta.ts` (P3) — drain-rate projection ("caught up by 6:40p") from fabric bench data
- `gc.ts` — raw deleted the moment its session is distilled
