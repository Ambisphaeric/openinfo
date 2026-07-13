---
name: next
description: Start a clean work session from the canonical GitHub issue dependency graph
---

# /next — do the next governed thing

1. Establish the authority order before selecting work:
   - an explicit owner-provided issue for this session;
   - otherwise the first open, unblocked item in the ordered checklist of GitHub issue #189;
   - `docs/NEXT.md` only as the local mirror, decision index, and offline resume record.
   An owner-required item remains blocked unless the owner is present. Never select a different
   implementation merely because the local mirror is easier to read.
   A tracker checkbox is only a mirror: live issue open/closed state wins. Reordering #189 requires
   the owner's recorded GitHub comment; an explicit issue must still be open and unblocked.
2. Read `docs/NEXT.md`, `git status`, and recent history. Use `gh` to read #189 and every candidate
   issue before choosing. Reconcile open/closed state, dependency text, owner gates, and checklist
   order with landed commits and PRs. If GitHub cannot be read, disclose the failure and stop before
   guessing issue state, dependency state, or acceptance criteria.
   "Owner present" means the owner explicitly participates in or directs the current session; do not
   infer it from a username. When changing these workflow rails, run `pnpm workflow:dry-run`.
   On a fresh clone, the intentionally gitignored `docs/NEXT.md` may be absent: disclose that it has
   no local decisions, reconcile GitHub first, then create a compact local mirror before dispatch.
3. Treat the selected issue body and acceptance criteria as the executable specification. State the
   issue, why it is unblocked, and the smallest independently verifiable slice in 2–3 lines. Respect
   its scope, non-goals, file boundaries, provenance/privacy constraints, and definition of done.
4. Before implementation starts, record the issue number and date as in flight in the current roadmap section of
   `docs/NEXT.md`. Do not revive or rewrite historical queue entries to represent current state.
5. Delegate bounded work when useful. Every implementation dispatch must preserve source identity,
   provenance, correction, privacy/egress policy, and honest unavailable/stale states. Surface work
   must use the repository's design skills and be exercised through real user entry points, timing,
   geometry, failure states, and Why/provenance navigation.
6. Verify in proportion to the issue's definition of done. Run the required targeted checks plus
   `pnpm -r build && pnpm -r test` before declaring the slice complete. Update the applicable phase
   notes and `CODE_MAP.md` rows in the same change; document any intentional exception in the issue.
7. Re-read the issue and #189 after verification. Report what is complete, what remains, the exact
   evidence, and recommend `/retro`. Do not close the issue or advance the roadmap merely because a
   partial slice landed.
