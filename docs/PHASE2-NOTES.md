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

## Slice: Moments v0 (typed extraction riding the distill pass)

### Where it lives — `distill/moments.ts`, not a new `moments/` module
CODE_MAP already homes moments under `distill/` ("merge · distiller · defaults/documents │
moments · ocr") — extraction *rides the distill pass*, shares its windows, voice resolution, and
llm invocation, and has no independent trigger. A sibling top-level module would invent a second
home for the same pass. The extractor itself is store-free and bus-free (pure given its injected
`invoke` + template) so it unit-tests against canned llm output without sqlite; the distiller owns
persistence + publishing, same as for distillates.

### One call vs two — chosen: a SECOND, tighter call per window
Weighed per the risk register (extraction quality on 3–8B local models is the known hard part):
- One combined call (summary + JSON in a single response) halves latency/cost, but asks a small
  model to do two jobs with two output grammars at once — exactly where 3–8B models fall apart,
  and a malformed response then costs the *summary* too.
- Two calls keep each job tight: the summary prompt stays prose-only; the extraction prompt demands
  ONLY a JSON array with a five-line kind glossary. A failed extraction never damages the
  distillate. The extraction prompt also receives the just-produced summary as `{{summary}}`
  context, which a combined call could not do.
The extra call runs on the drain (idle path), not in the capture request budget, so doubling
per-window llm time is the cheap side of the trade. Revisit if drains back up on real hardware.

### Contracts
- `Moment` gains an OPTIONAL `provenance` (distillateId, window bounds, slot/endpoint/model) —
  additive, backward-compatible (Phase-0 examples still validate); every extracted moment is
  inspectable back to its window and model (product principle 1). No existing field changed.
- `Moment.kind` was NOT changed: the Phase-0 enum's `question` is the "◆ question-at-you" of
  IMPLEMENTATION Phase 2 (the schema's own description says so); `mention`/`note` remain valid
  kinds but the extractor only emits the four typed ones.
- `PromptTemplate.kind` gains `extract` (was distill|act) — extraction prompts are versioned,
  cloneable documents like everything else; `tpl-extract-default` is seeded beside the distill
  template and mirrored in `examples/promptTemplate.extract.json`.
- `GET /moments` added to the Routes contract (phase 2). `moment.created` in the Events contract
  already carried `Moment` — no placeholder to correct this time.
- Flag `distill.moments` (OFF, scope engine). **Interaction: moments require distill.enabled** —
  the drain processor returns before the distiller runs when distill is off, so distill.moments
  alone does nothing. Both flags are read per-drain; flipping either over the API takes effect
  without a restart.

### Robust structured output (the malformed-JSON policy)
Small local models emit fences, prose preambles, trailing commas, and half-broken arrays. Policy,
in order:
1. Strip code fences; try the whole response as JSON (array, `{moments: []}` wrapper, or a single
   object all count as parsed). A clean `[]` is a **normal zero-moment window, not an error**.
2. Otherwise scan for top-level balanced `{…}` substrings (string-literal/escape aware) and parse
   each independently — an array with one broken element still yields its intact siblings.
3. Every candidate is rebuilt server-side (ids, timestamps, provenance are stamped, never trusted
   from the model; confidence clamped to 0..1, default 0.5) and validated against the full Moment
   TypeBox schema. Invalid candidates are **dropped, not retried** — retrying one bad element of an
   otherwise-good response re-pays the whole call for noise.
4. A *wholly unparseable* response is re-sampled within the pass, bounded (default 2 attempts),
   then yields zero moments. **Transport failures propagate** — the drain re-queues the spool file
   (the existing retry-at-idle), so extraction retries ride the same recovery as distill itself.

### Store + API
- `WorkspaceRegistry.saveMoment/listMoments` — a `moments` table per workspace file, only-store-
  opens-DB rule intact; idempotent per moment id. `GET /moments?workspace=&session=` mirrors how
  registers are served; unknown workspace reads as `[]`, not an error.

### Deferred (out of this slice, by scope)
- `refs` (entity ids) is always `[]` — entity records + linking land with index v0 (next slice).
  `speaker` is the raw label the model heard, not an entity id yet.
- Dismiss/teaching-loop write path (`Moment` has no status field; nothing to populate). `answered`
  is persisted when the model emits it for questions; nothing updates it later yet.
- Retry-at-idle *upgrades* (re-running weak extractions with `llm.smart`) — the queue seam supports
  it, but endpoint tiering is not wired; today a drain failure simply re-runs the same pass.
- Deduplication across overlapping windows: windows don't overlap in v0, so not needed yet.
