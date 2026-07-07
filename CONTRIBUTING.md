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
1. `shared/contracts/src/config/fabric.ts` — append runtime name to `LocalRuntime`.
2. `apps/engine/src/fabric/endpoints/local.ts` — add the spawn/health/bench adapter case (one function).
3. Bench it: `tools/bench` must produce measured numbers before the runtime may appear in docs/examples.

## The quality gate

`pnpm test` (types, schema validation of every example document, unit tests) + `tools/evals` regression on the
golden fixtures at your hardware's tier. A PR that improves a prompt template must show the eval delta.
