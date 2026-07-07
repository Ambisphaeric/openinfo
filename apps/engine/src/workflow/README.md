# engine/workflow — Phase 2 (loom transplant) — NOT YET BUILT

Intended: loom `packages/recipe` (a DAG executor) + `compile.ts` (mode document → executable DAG),
where the five processing primitives (source/distill/route/overlay/act) are the only node types.

## Status after Phase 2: still a design placeholder — nothing was built here, deliberately.

No Phase-2 slice ran through a DAG. Every processing behavior is wired **directly** into the seam
that naturally triggers it, and each is gated by its own flag:

| Primitive | Where it actually runs today | Trigger |
|---|---|---|
| Source   | `client/capture` → `POST /capture` → `queue/spool` | live capture |
| Distill  | `distill/distiller` on the queue **drain** | idle/backlog (`distill.enabled`) |
| (moments)| `distill/moments` riding the same drain pass | `distill.moments` |
| (index)  | `index/extract` riding the same drain pass | `distill.index` |
| Overlay  | `voice/` resolution, interpolated into every distill/act prompt | inline |
| Act      | `act/` (follow-up draft) on **`session.ended`** | `act.enabled` |

### Why the Act node did NOT force the DAG transplant (the slice-6 decision)

The "first Act node" language invited transplanting the recipe executor now. It was weighed and
declined — a DAG executor for a **single, unchained, one-node graph** is ceremony, not foundation:

- The follow-up draft is not chained to another node and has exactly one trigger (session end). A
  DAG's whole value — declared edges, fan-out, ordering across nodes — has nothing to bite on yet.
- Every other P2 primitive is wired directly for the same reason, and each reads cleanly at its own
  seam. Introducing a compile-mode-to-DAG layer for one node would add an indirection every reader
  must now trace through, buying nothing this phase uses.
- The primitives are already **named and homed** (`distill/`, `index/`, `voice/`, `act/`, `route/`),
  so the eventual executor composes existing modules rather than absorbing them — no rework debt.

### What forces the transplant later (the real trigger)

Build the recipe executor when a mode needs **more than one act** and/or **chained nodes** — e.g.
follow-up-draft **and** task-extract from the same session, or an act whose input is another act's
output, or per-mode act ordering/fan-out. At that point `compile.ts` turns `Mode.acts` (+ sources/
distill/overlay config) into a DAG and the direct triggers here become node invocations. Until then
the direct wiring is the honest shape. (P3's route node is the next primitive likely to land; it,
too, can start direct and join the DAG when composition demands it.)
