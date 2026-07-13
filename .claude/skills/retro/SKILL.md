---
name: retro
description: Verify governed work, append durable evidence, and reconcile the canonical issue roadmap
---

# /retro — retrospective + governed requeue

1. Identify the scoped GitHub issue for the completed work and the exact baseline commit recorded by
   the last relevant `docs/RETRO.md` entry. Compare `git log <baseline>..HEAD`, the working tree, and
   linked PRs; a date alone is not a reproducible baseline. Use `gh` to read the issue and #189. If
   GitHub cannot be read, disclose the failure and stop before any issue or roadmap mutation. If a
   fresh clone has no gitignored `docs/RETRO.md`, create it only after GitHub is reconciled. If the
   exact baseline cannot be established, record that gap and do not close or advance the issue.
2. Verify every acceptance criterion and definition-of-done item against landed code, tests, and
   observable behavior. Use bounded subagents for independent spot checks when useful. Run the
   required targeted checks plus `pnpm -r build && pnpm -r test`, and report failures honestly.
   Provenance/privacy claims and surface design, real-entry, timing, geometry, failure-state, and Why
   navigation gates require explicit evidence when they are in scope.
   When changing these workflow rails, run `pnpm workflow:dry-run`; its snapshot-only model must show
   incomplete work staying open and fully verified work producing close/tracker/NEXT actions.
3. Append a dated entry to `docs/RETRO.md`; never rewrite prior entries. Record the exact baseline and
   head SHAs, issue link, linked PRs and/or commits, shipped evidence, deferred/cut scope, tests, surprises, unresolved
   decisions, and the recommended next issue.
4. Close only the scoped issue, and only when every required acceptance criterion is genuinely complete. If
   work remains, leave it open and state the remaining criteria. Create narrowly scoped follow-up
   GitHub issues for newly discovered executable work instead of leaving a prose-only backlog.
5. Reconcile #189 and the compact current-roadmap section of `docs/NEXT.md`: update checklist state,
   dependencies, issue/date annotations, and the next open unblocked target. GitHub remains canonical;
   `NEXT.md` is its local mirror, while completed historical detail belongs in `RETRO.md`.
6. End with a one-line recommendation for the next `/next`, including the issue number and why its
   dependencies are satisfied.
