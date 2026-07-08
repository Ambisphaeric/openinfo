# engine/workflow — the pipeline as a document (P4A)

Intended (loom origin): `packages/recipe` (a DAG executor) + `compile.ts` (mode document → executable
DAG), where the processing primitives (source/distill/route/overlay/act) are the only node types.

## Status: executor v0 BUILT (P4A slice 2) over a LINEAR document — the DAG is still deferred.

`executor.ts` (`WorkflowExecutor`) runs a `WorkflowSpec` document against the two seams the hardcoded
pipeline used — the queue **drain** (`runDrain`: transcribe? → distill → moments/index) and
**session-end** (`runSessionEnd`: the follow-up-draft act). `documents.ts` (`WorkflowDocuments`) seeds
the shipped `workflow-default` (loaded from `shared/contracts/examples/workflow.default.json`) and is
read FRESH per call (the flags/surfaces hot-edit pattern). The executor is gated by `workflow.enabled`
(default OFF): OFF leaves the legacy direct-wiring in `api/http.ts` untouched; ON runs the document and
is **behavior-identical** — same flags honored (`distill.enabled/transcribe/moments/index`,
`act.enabled`), same retry-at-idle propagation, same drain-first flush on session end.

Two deliberate holds remain from the pre-P4 design below:

- **Still a LINEAR list, not a DAG.** `WorkflowSpec.steps` has no declared edges/fan-out; the executor
  coalesces the distill-family steps (distill + moments + index → one `distiller.distillChunks` call)
  and dispatches acts by step id. The DAG trigger below (more than one chained act) still forces the
  graph shape later, additively (edges as an optional field).
- **`compile.ts` (mode → DAG) not built.** The executor reads a hand-authored `WorkflowSpec` document
  directly; nothing compiles `Mode.acts` into it yet.

## History — why the Act node did NOT force the DAG transplant at Phase 2 (the slice-6 decision)

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

### The reasoning (weighed and declined at Phase 2)

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
