# Phase 2 Notes

Records decisions/deviations as each Phase 2 slice lands, in the PHASE1-NOTES style.

## Slice: Distill v0 (rolling merge + voice interpolation + llm slot)

### Contracts added
- `Distillate` (records/distillate.ts): a merge-window summary — sessionId, workspaceId,
  windowStart/End, sourceChunks (chunk id refs), text, the resolved `voice` vector
  (registerId + winning scope + dials), model/endpoint `provenance`, and `schemaVersion`
  (`DISTILLATE_SCHEMA_VERSION = 1`, exported for the distiller to stamp). Persisted per workspace.
- `PromptTemplate` (config/promptTemplate.ts): a versioned, cloneable prompt document (kind
  distill|act) — no hardcoded prompt presets (the glass mistake). The body interpolates
  `{{tone}}…{{brevity}}`, `{{voice.rules}}`, and pass inputs like `{{transcript}}`.
- `distillate.updated` event now carries a `Distillate` (was a placeholder `Moment`). This is the
  one existing-contract touch; it is a correction, not an incompatible walk-back — no record schema
  changed shape.
- Flag `distill.enabled` (OFF by default, scope engine) added to `flag.examples.json`, which is the
  seed source `ensureDefaultFlags` reads.

### Seam choice — distill rides the queue drain (not the live bus)
The task offered two seams: the queue drain (`spool.ts`, previously a no-op processor) or the live
bus `capture.received`. **Chosen: the drain.** Rationale:
- The drain already owns the raw chunks durably (per-session JSONL) and is the idle/backlog path;
  processing there gives free retry-at-idle (on processor error the file is returned to the pending
  path, so capture is never lost) and matches the "process at idle, delete raw after" overflow
  policy in ARCHITECTURE §7.
- The bus fires one chunk at a time synchronously inside the capture request; windowing a rolling
  30s→2m merge from single-chunk events would mean holding mutable in-memory window state across
  requests — more moving parts, and it competes with the request latency budget.
- The e2e test the slice requires ("drain → distill → store → bus") falls out naturally.

`CaptureQueue` gained an optional `DrainProcessor`. With no processor it is exactly the Phase 1
no-op GC; with one it parses each drained file to `CaptureChunk[]` and hands them over. The engine
wires a processor that distills **only when `distill.enabled` is on** (read per-drain, so flipping
the flag over the API takes effect without restart). Flag off ⇒ the drain stays the Phase 1 GC.

### Voice resolution (dials v1)
- `voice/resolve.ts` is pure: given registers + bindings + a scope context it walks precedence
  session > workspace > mode > global, applies the register vector then per-binding `dialOverrides`,
  and falls back to a neutral 5/10 vector when nothing is bound (so a template always interpolates).
  A dangling binding (register id not found) falls through to the next scope rather than erroring.
- `voice/interpolate.ts` compiles a dial vector into raw `{{dial}}` vars plus a `{{voice.rules}}`
  guidance snippet (coarse thresholds, e.g. charm ≤3 → "avoid humor"), so small local models are
  not handed bare numbers. Unknown placeholders resolve to empty string.
- **A mode's `registerId` is treated as its mode-scope default binding** (IMPLEMENTATION §1: "a mode
  declares a default"). The distiller synthesizes this binding at mode precedence and appends it
  after stored bindings, so an explicit mode-scope binding still wins. This is why the shipped
  meeting mode resolves to `boardroom` with no separate binding document.
- Registers + bindings live as `_meta.db` config docs (`VoiceDocuments`, mirroring
  `FabricDocuments`). A small id/key index doc under each kind lets us list without a store-schema
  change. Five builtin registers are seeded only when absent.

### LLM slot invocation
- `fabric/invoke.ts::invokeLlm` tries `fabric.slots.llm` in order (first that answers wins), POSTing
  the OpenAI-compatible `/v1/chat/completions` shape (mlx / LM Studio local servers). `local`
  endpoints are a stub (skipped), `cloud` is out of scope; if none answer it throws with the per-
  endpoint failure list. Tests use an in-process fake HTTP server returning canned completions — no
  real model calls in CI.

### Store
- `WorkspaceRegistry.saveDistillate/listDistillates` are the only path that writes distillates
  (DB-handle hard rule). A `distillates` table is created per workspace file; the workspace is
  created on demand if a pass references an unregistered one.

### API
- `GET /registers` (in the Phase 2 Routes contract) now serves the seeded registers — cheap
  exposure of the voice docs, useful for inspecting the bound register.

### Deferred (out of this slice, by scope)
- Moments / typed entity extraction (next slice) — the distiller emits summary text only.
- HUD surface / block rendering, sessions lifecycle, router, comparator/drift, Act (follow-up
  draft). The distiller resolves voice by `sessionId`/`workspaceId` from the chunk and `modeId` from
  the default meeting mode; real session records (with their own modeId/registerId) arrive with the
  sessions slice.
- Non-text capture (screen/base64) is filtered out of distill v0; screen understanding is OCR (P3).
- Per-user/per-context flag overrides: `isFlagEnabled` reads the flag document `default` for now.
