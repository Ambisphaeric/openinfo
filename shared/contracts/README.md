# @openinfo/contracts — Phase 0
The only package everything else may depend on. Nothing crosses the client⇄engine seam untyped.

- `src/records/` — commitment, moment, entity, session, workspace, pin
- `src/config/`  — surface (block/action), mode, voice (dials/registers/bindings/chains), fabric, flag
- `src/api/`     — HTTP route + WS event definitions (names, payloads)
- `src/query/`   — the block query DSL: grammar, types, compile target interface
- `schemas/`     — generated JSON Schema (the language-neutral artifact; a future Rust engine reads these)

Rule: contracts export types + validators + example documents. No runtime logic, no IO.

`schemas/` is generated — never hand-edit it. After any change to the contract source, run `pnpm --filter @openinfo/contracts gen` and commit the result. Drift (source changed, schemas not regenerated) fails both CI and the local `pnpm -r test` suite.
