# Contributing to openinfo

This codebase is designed so that **local models can contribute safely**. That works because changes are
tiered by surface, and the lower tiers are mechanical: schema-validated documents and recipe-shaped code.

## Tiers

| Tier | Change surface | Who/what can do it | Gate |
|---|---|---|---|
| **A** | Documents: registers, templates, surfaces, flags, taste packs, pins | Any capable model or human, via shipped `skills/` | JSON-Schema validation (a wrong document cannot ship) |
| **B** | Code-by-recipe: new block type, new watcher, new fabric runtime, new act kind | ~30B-class local models on rails, humans | Recipe below + types + tests + evals regression |
| **C** | Core: `shared/contracts`, `engine/store`, `engine/route`, the seam | Humans + frontier models | CODEOWNERS review, design note in ARCHITECTURE.md first |

## Style rules (chosen for machine-writability)

1. One concern per file; files under ~200 lines; no barrel re-export magic — explicit import paths.
2. `tsconfig` strict everywhere; no `any`; no `@ts-ignore` (a recipe that needs one is a broken recipe).
3. Flags gate **engine processing behaviors**, default OFF — an optional code path that runs over your data
   (`distill.enabled`, `distill.moments`, `distill.index`, `act.enabled`, `workflow.enabled`, `capture.sim`, `fabric.http`).
   What is deliberately NOT flagged: resource/document CRUD and read surfaces — sessions, surfaces/layouts,
   profiles/secrets, `/query`, the `/setup` page. A lifecycle record, a versioned document, or a read route
   is not a behavior a flag would gate, and its data is already gated upstream by the processing flag that
   produced it (a `sessions.enabled` flag "would gate nothing that isn't already gated" — sessions slice,
   PHASE2-NOTES). Client-local window behavior (always-on-top, content-protection, ⌘\) is *config*, not a
   flag — it never touches the engine or its store.
4. Conventional commits (`feat(engine/ledger): …`); one recipe = one commit.
5. Tests colocated: `foo.ts` → `foo.test.ts`, `node --test`, no test framework beyond node built-ins.
6. Never import across the seam: apps depend on `@openinfo/contracts` only. `spikes/` is unimportable.
7. **Definition of done — keep the agent-facing paper true.** A slice that changes a route, a flag, or a
   recipe-touched surface MUST update `skills/` and the CONTRIBUTING recipes in the SAME commit. The skills
   and recipes are rails a local model follows blindly; a route/flag change that leaves them stale is a
   broken rail, not a follow-up. (There is no root `CLAUDE.md`; this rule lives here.)

## Recipes (Tier B)

Each recipe lists exact files, in order. Follow them literally; deviation means the change is Tier C.

### Add a built-in block type
1. `shared/contracts/src/config/surface.ts` — append the type name to `BlockTypeName` (append-only union).
2. Data source: if the block reads data, it needs a `BlockQuery.source`. Reuse an existing source (in the
   `BlockQuery.source` union, same file) if one fits; only if you need a NEW source do you (a) add it to that
   union and (b) handle it in `apps/engine/src/surfaces/query.ts` — the `compileQuery` switch, which reads
   through `store/` per the DB-handle rule (unbuilt sources return `[]`, not an error). A layout-only block
   (like `now`) needs no query and no engine change.
3. `apps/client/src/surfaces/blocks/<name>.ts` — the renderer: a pure `(block config + hydrated QueryResult)
   → VNode` function; it never fetches (the block-renderer supplies the data). THEN register it in
   `apps/client/src/surfaces/blocks/index.ts` (`defaultBlockRegistry`, keyed by the new `BlockTypeName`).
4. No flag. A new built-in block type is not gated — `renderSurface` routes any unknown/forward type to the
   `custom` fallback renderer, so a forward document never breaks. (The DATA a block shows is gated upstream
   by its source's flags, e.g. `distill.*` — not by the block type.)
5. Tests: a `Surface` example exercising the block (validated by contracts.test); a renderer/registry case in
   `apps/client/src/surfaces/block-renderer/renderer.test.ts`; and, if you added a source, a `compileQuery`
   case in `apps/engine/src/surfaces/query.test.ts`. Run `pnpm -r test` and the evals smoke.

### Add a settings section
The engine-served Settings surface (`GET /settings`, formerly `/setup`) is a sidebar of sections behind ONE
registry — mirroring the block-renderer registry. Adding a section is a module + a line.
1. `apps/engine/src/surfaces/settings/sections/<name>.ts` — the section body: a pure `render(data: SetupData)
   → string` function (no I/O, no DOM). Reuse the existing helpers (`escapeHtml`, `jsonForScript`) and the
   shared CSS classes (`.card`, `.sub`, `.stat-*`, `.feat-*`). If it needs live data the shell doesn't yet
   assemble, add an OPTIONAL field to `SetupData` (`setup/view.ts`) and populate it in `getSettings`
   (`api/http.ts`) — cheap in-process reads only; network work (like discovery) runs only when that section
   is the active one.
2. Register it in `apps/engine/src/surfaces/settings/registry.ts` — one entry in `SECTIONS`
   (`{ id, group, label, render, liveDot? }`). Pick a `group` from `GROUP_ORDER` (top · models · pipeline ·
   surfaces · diagnostics · bottom); a new group means adding it to `GROUP_ORDER` + `GROUP_LABEL`. `liveDot`
   is optional — a cheap, server-rendered sidebar dot/count (no polling).
3. No flag. Serving a settings section is a read surface, not a gated engine behavior (rule 3). If the section
   WRITES, compose an EXISTING route from its thin browser script (the Features section flips flags via
   `PUT /flags/:key`; the editor uses the fabric/surface routes) — no new engine capability (the P6 rule).
   A per-section `<script>` IIFE is fine; concat it into `SETTINGS_SCRIPT` (`settings/assets.ts`).
4. Tests: assert the section render is non-empty and shows its key content in
   `apps/engine/src/surfaces/settings/shell.test.ts` (or a colocated `sections/<name>.test.ts` for richer
   cases); if you added a `SetupData` field, cover its assembly in `apps/engine/src/api/http.test.ts`. Run
   `pnpm -r test`.

### Add a ledger watcher — FUTURE (P4; `engine/ledger/` is a scaffold today, README only)
The ledger and its watchers are Phase 4 — the module is not built yet, so this recipe describes the intended
shape, not files you can edit now. When P4 lands:
1. Implement `Watcher` from contracts in `apps/engine/src/ledger/watchers/<kind>.ts`.
2. Register it in the watcher table (one line, `ledger/watchers/index.ts`).
3. Flag `ledger.watcher.<kind>`, default OFF. Example commitment document exercising it. Test with a fixture.

### Add a fabric runtime (e.g. a new local engine)
1. `shared/contracts/src/config/fabric.ts` — append runtime name to `LocalRuntime` (additive only).
2. `apps/engine/src/fabric/endpoints/local.ts` — add a `RuntimeSpec` to `RUNTIME_SPECS` (binary names,
   install hint, argv builder, health path, and the HTTP surface: `chat` for OpenAI-compat chat, or a
   `transcribePath` for a whisper-style transcription endpoint). The `LocalRuntimeManager` does the
   discovery/spawn/readiness/kill/bounded-restart generically; the spec is all a new runtime needs.
3. If the runtime speaks a NON-OpenAI-compat surface for its slot, wire it in `fabric/invoke.ts` (the
   `local` branch resolves the spawned url + spec, then speaks the right path — e.g. whisper.cpp's
   `/inference` vs the http kind's `/v1/audio/transcriptions`).
4. To make it downloadable at tier zero: add entries to the seeded `fabric/local-defaults.ts` catalog
   (slot, runtime, direct URL, filename, honest size) — `LocalModelStore` handles download/resume/state.
5. Bench: `tools/bench` produces measured tok/s for **http** endpoints. For `local`, bench stays stubbed
   in v0 — real numbers need a hardware run (`benchHttpEndpoint` returns local endpoints unchanged); a
   local endpoint therefore carries no `measured` block until benched on the target machine. Don't seed
   fabricated tok/s.

**Reality note (drift rule):** `endpoints/http.ts`/`endpoints/cloud.ts` never materialized — the `http`
kind is handled inline in `invoke.ts`/`health.ts`, and `cloud` is P7. Only `local` needs its own module
(`endpoints/local.ts`) because it owns real process lifecycle. The recipe above matches that reality.

## The quality gate

`pnpm test` (types, schema validation of every example document, unit tests) + `tools/evals` regression on the
golden fixtures at your hardware's tier. A PR that improves a prompt template must show the eval delta.
