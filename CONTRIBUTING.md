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
3. Every user-visible behavior is behind a flag document, default OFF.
4. Conventional commits (`feat(engine/ledger): …`); one recipe = one commit.
5. Tests colocated: `foo.ts` → `foo.test.ts`, `node --test`, no test framework beyond node built-ins.
6. Never import across the seam: apps depend on `@openinfo/contracts` only. `spikes/` is unimportable.

## Recipes (Tier B)

Each recipe lists exact files, in order. Follow them literally; deviation means the change is Tier C.

### Add a built-in block type
1. `shared/contracts/src/config/surface.ts` — add the type name to `BlockTypeName` (append-only).
2. `apps/engine/src/api/routes/` — extend the block-data resolver for the new type (one function, one file).
3. `apps/client/src/surfaces/blocks/<name>.ts` — the renderer; consumes typed data, renders DOM, no fetch calls
   (the block-renderer supplies data).
4. Flag document: `surface.block.<name>`, default OFF.
5. Tests: schema example + resolver test. Run `pnpm test` and the evals smoke.

### Add a ledger watcher
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
