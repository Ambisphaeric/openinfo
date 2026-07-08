---
name: next
description: Start a clean work session — pick the top unblocked item from docs/NEXT.md and dispatch it via opus subagents
---

# /next — do the next thing

1. Read `docs/NEXT.md` and run `git log --oneline -20` to see what actually landed since the
   queue was last touched (an "in flight" item may be done or dead — trust the log over the doc).
2. Pick the **topmost unblocked item** (skip anything marked founder-required unless the founder
   is present in this session). State the pick and its slice plan in 2–3 lines; if the founder
   gave an argument to /next, that overrides the queue order.
3. Dispatch implementation to **opus subagents** (delegate hands-on work — don't inline-edit
   engine code in the main loop). Standing constraints for every dispatch:
   - commit per module/slice; `pnpm -r build && pnpm -r test` green before each commit
   - respect the item's **Owns / Must-not-touch** file boundaries (parallel terminals exist)
   - update `docs/PHASE*-NOTES.md` + CODE_MAP rows (rule 7) with the final slice
4. Mark the item in-flight in `docs/NEXT.md` (one line, with date) before dispatching.
5. When the work completes and verifies, say so plainly and recommend running `/retro`.
