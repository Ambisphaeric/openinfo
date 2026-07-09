---
name: retro
description: Close out finished work — verify what landed, log a retro entry, and requeue docs/NEXT.md
---

# /retro — retrospective + requeue

1. Find the last entry date in `docs/RETRO.md` (create the file with an empty log if absent),
   then `git log --oneline` since that date. Run `pnpm -r build && pnpm -r test` and report
   results honestly — failing tests go in the entry, not under the rug.
2. For each item that claims to have landed, spot-verify against its `docs/NEXT.md` spec via a
   subagent (does the seeded document exist? does the flag gate? does the API respond?). Note
   drift between spec and what shipped.
3. Append a dated entry to `docs/RETRO.md`: **shipped** (commits, one line each), **deferred/cut**
   (and why), **surprises/gotchas** worth remembering, **decisions needed from the owner**
   (these also get a line in NEXT.md's design-session/queue area).
4. Update `docs/NEXT.md`: remove done items, reorder if the retro changed priorities, add
   follow-up slices discovered during the work.
5. Update the auto-memory resume-point (settings-rework-next.md or successor) so a cold session
   knows where things stand.
6. End with a one-line recommended target for the next `/next`.
