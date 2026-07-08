---
name: add-a-block
description: Add a new block to one of your surfaces (HUD, workbench) by editing its surface document. Use when the user wants a new panel section, a pinned doc card, or a custom query view.
---

# Add a block

Adding a block is a pure document edit — you fetch a surface, splice a block into its `stack`, and PUT
it back. No application code, no new route. Every step below is a real engine call; verify each against
`shared/contracts/src/api/routes.ts`.

**Prefer the forms editor when a human is driving.** `GET /setup?surface={id}` is an engine-served
HUD-layout editor (forms over the surface document): reorder/add/remove blocks, toggle `collapsed`, set
`top`/`show`, rename, clone, or edit raw JSON, then Save. `/setup` also lists every surface under "HUD
layout". The steps below are the API path (for scripts/agents); the editor uses these exact routes.

1. Enumerate surfaces with `GET /layouts/surfaces` (→ `Surface[]`), or fetch one directly:
   `GET /layouts/surfaces/{id}` (200 → a `Surface`; 404 if no such id — e.g. `surf-openinfo-hud` is the
   shipped HUD). **Keep this exact document** — it is how you revert (step 6).
2. Choose a block type. The built-ins are the enum at `GET /contracts/BlockTypeName` (a JSON Schema whose
   members are the valid `block` values: `now` · `moments` · `relevant-now` · `ledger` · `pinned-doc` ·
   `hint` · `ask` · `custom`). Prefer a built-in over `custom`.
3. Compose the block object and validate it against the `Block` schema — fetch it with
   `GET /contracts/Block` (returns the JSON Schema) — BEFORE writing. A data block needs a `query`
   (`{ source, params, top? }`, where `source` is one of relevant-now/moments/sessions/entities/ledger/
   pins); set `show` (`always` | `on-match` | `manual`) and optionally `collapsed`/`top`. A layout block
   like `now` needs no query.
4. Insert the block into the surface's `stack` array at the position the user asked for.
5. Save by PUTting the WHOLE surface document back: `PUT /layouts/surfaces/{id}`. The body must be a full
   `Surface` whose `id` matches the route. The engine revalidates the whole document and **stamps the next
   `version` itself** — your `version` field is required by the schema (integer ≥ 1) but its value is
   ignored on save; the store increments the latest stored version. On success `200` returns the saved
   document with the bumped version. On **`400`** the body is `{ "error": "invalid Surface", "details":
   [ ... ] }` — read `details` (e.g. `"/stack/0/block: Expected union value"`), fix, retry once. The PUT
   also emits a **`surface.updated`** WS event carrying the saved doc — any HUD rendering THIS surface id
   refetches and re-renders within a second (no restart). Clone a surface by PUTting a copy under a NEW id
   (there is no clone endpoint — PUT creates if absent).
6. Revert: **there is no rollback endpoint** (`POST /layouts/surfaces/{id}/rollback` does not exist). The
   engine keeps every prior version internally, but the API way to undo is to PUT back the document you
   kept from step 1 — the engine stamps a new version whose shape matches the pre-edit one. So: hold the
   pre-edit document; to undo, PUT it again.

Saving a surface is **not** behind a flag (serving/saving a layout is a resource route, not a gated
behavior). But a block only shows DATA when its source is populated, and the sources are gated upstream:
`moments`/`relevant-now`/`entities` need `distill.enabled` (+ `distill.moments` / `distill.index`) ON, and
`ledger` (P4) / `pins` (P3) have no backing store yet so they render empty-but-explainable. Tell the user
which upstream flag a data block depends on so an empty block reads as expected, not broken.

Never: edit application code to add a block; invent a block type (`BlockTypeName` is append-only — a NEW
built-in type is the CONTRIBUTING "Add a built-in block type" Tier-B recipe, not a document edit); write a
document that fails validation.
