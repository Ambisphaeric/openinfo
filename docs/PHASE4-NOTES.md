# Phase 4 Notes

Records decisions/deviations as each Phase 4 slice lands, in the PHASE3-NOTES style.

## Slice: WorkflowSpec contract — the workflow substrate's typed seam  *(P4A, Terminal A, on main)*

CONTRACTS ONLY. The first slice of P4A ("Workflow substrate + typed queues + dynamic to-do") lands the
document type the executor will run, and nothing else — no executor, no `api/http.ts` touch, no
`workflow/` code. The largest vision↔build gap is that the pipeline is hardcoded direct-wiring in
`api/http.ts` (drain → transcribe? → distill → moments/index; `session.ended` → follow-up draft) and
`apps/engine/src/workflow/` is a README-only deferral. This slice makes the pipeline a **document**
(ARCHITECTURE §2: everything the user can configure is a cloneable, versioned JSON record → it gets the
templates/editor surfaces for free) so slice 2 can migrate the wiring to a behavior-identical seed.

### Contracts added (all additive)
- **`WorkflowSpec`** (`config/workflow.ts`): the document. Envelope follows the house convention for
  versioned config docs verbatim — `id` (`Id`) · `name` · `version` (Integer ≥1, store-stamped monotonic)
  · `description?` — matching `Mode`/`Surface`/`FabricProfile`. Body is `steps: WorkflowStep[]`
  (`minItems: 1`, like `Mode.sources`/`Surface.stack`).
- **`WorkflowStep`**: `{ id, kind, slot?, templateId?, when?, trigger?, params }`. Array order IS pipeline
  order. `slot?` reuses the shared `SlotName` union (stt/tts/llm/vlm/ocr/embed) — reuse, not a fork.
  `templateId?` is an `Id` referencing a `PromptTemplate`/act-template document. `params` is
  `Type.Record(String, Unknown, { default: {} })` — the free bag the executor slice interprets (same
  shape as `Mode.acts[].params`, `Block.query.params`, `Action.params`).
- **`WorkflowStepKind`**: append-only union `transcribe | ocr | vlm | distill | moments | index | act`.
- **`StepGate`**: the `when?` gate, v0 = `{ flag: string }`.
- Registered all four in `index.ts` (`AllSchemas` + re-exports); mapped `workflow → WorkflowSpec` in
  `contracts.test.ts`; seeded `examples/workflow.default.json` (validated). Schemas regenerated
  (`pnpm --filter @openinfo/contracts gen` → 60 schemas, +4).

### Decision — the `kind` union is CLOSED (append-only), unlike `BlockTypeName`
`BlockTypeName` deliberately routes an unknown/forward type to the `custom` fallback renderer, so a
forward Surface document never breaks a client. A workflow step is the opposite case: it *does work* and
has **no safe execution fallback** — an executor cannot invent what a `foo` step means, and silently
no-op'ing an unrunnable kind would hide a broken document instead of surfacing it. So the union is closed
and grows only by appending here; an unrunnable kind is rejected at document-write time (the Tier A
JSON-Schema gate), which is exactly where a "wrong document cannot ship" belongs (CONTRIBUTING Tier A).
Mirrors `MomentKind`/`LocalRuntime`, not `BlockTypeName`.

### Decision — `moments`/`index` are their own step kinds, gated 1:1 to their flags
Reality: `distiller.distillChunks(ready, { extractMoments, extractEntities })` is ONE call with three
independent flags (`distill.enabled` gates the call; `distill.moments`/`distill.index` gate the two
extract options). Two honest representations were weighed:
- (A) one `distill` step whose `params` carry the moments/index flag names — ugly (params carrying flag
  keys) and hides two user-editable behaviors inside one step;
- (B) **separate `distill` / `moments` / `index` steps, each with its own `when.flag`** — chosen.
It maps 1:1 to the five real flags (`when.flag` per step), it is the more editable
everything-is-a-document shape (a user toggles the `moments` step as a step), and array order captures
the real ordering (transcribe → distill → moments/index). This required appending `moments` to the kind
union alongside the already-mandated `index`; both are genuine, distinct extraction outputs
(`distill/moments` typed moments vs `index/extract` entities). **Seam note for slice 2 below** covers how
the executor must fold these three back into the single `distillChunks` call.

### Decision — `trigger?: 'drain' | 'session-end'` represents "act rides session.ended, not the drain"
The honest device the mandate asked for. `drain` (default) is the queue-drain seam (idle/backlog path);
`session-end` is `bus.subscribe('session.ended', …)`. The default workflow's four drain steps carry
`trigger: 'drain'` and the follow-up-draft act carries `trigger: 'session-end'` — a faithful, readable
mirror of the two seams in `api/http.ts` (the `session.ended` handler `drainNow()`s first, then drafts).
`session-end` also encodes the ≤60s post-session latency via the act step's `params.latencySecPostSession`
(60), matching `mode.meeting.json`'s `follow-up-draft` act params.

### Decision — `when?` is a single flag key in v0; the condition DSL is DEFERRED
`when: { flag: string }` — the step runs only when that `Flag` key is enabled. This is exactly enough to
make the default workflow a faithful mirror of today's per-flag wiring, with **no condition language that
nobody executes yet**. Deferred (do not invent ahead of an executor that runs it): a condition DSL over
session/mode/hardware state — when it lands it becomes another optional member of `StepGate`
(e.g. `condition?`), additively, next to `flag`.

### The example slice 2 must seed
`shared/contracts/examples/workflow.default.json` — id **`workflow-default`**, name "default pipeline".
Five steps, in order: `transcribe` (slot stt, drain, when `distill.transcribe`) → `distill` (slot llm,
templateId `tpl-distill-default`, drain, when `distill.enabled`) → `moments` (drain, when
`distill.moments`) → `index` (drain, when `distill.index`) → `follow-up-draft` (kind act, slot llm,
templateId `tpl-followup-default`, trigger session-end, when `act.enabled`, params
`{ latencySecPostSession: 60 }`). Shaped against the real wiring so slice 2 can seed it as the
behavior-identical default.

### Seam notes the executor slice (P4A slice 2) MUST know
- **Coalesce the drain distill-family steps into ONE `distiller.distillChunks` call.** `distill`,
  `moments`, `index` are three flag-editable steps in the document but ONE pass at runtime. The executor
  reads: run `distillChunks(ready, { extractMoments: <moments step present AND its when-flag on>,
  extractEntities: <index step present AND its when-flag on> })`, and the whole call is gated by the
  `distill` step's when-flag (`distill.enabled`). The `transcribe` step is the pre-stage
  (`transcribeChunks` when its when-flag is on) that rewrites chunks before `distillChunks`. This
  coalescing is the executor's job, NOT the document's — the document stays the honest, per-flag list.
- **`when.flag` gates a single flag; it does NOT express inter-step dependencies.** In reality
  `moments`/`index` only happen because they are options on the distill call, which only runs under
  `distill.enabled`. That structural "rides the distill pass" dependency is enforced by the coalescing
  above, not by a multi-flag `when`. Do not read a `moments` step's `when.flag` as sufficient to run it
  standalone — there is no standalone moments pass today.
- **`workflow.enabled` gate (slice 2's, not this slice's).** Slice 2 adds a `workflow.enabled` flag,
  default OFF, and leaves the legacy direct-wiring path untouched when OFF. This slice adds NO flag (a
  document type is a read/CRUD surface, not a gated engine-processing behavior — CONTRIBUTING rule 3).
- **DAG deferral still holds** (workflow/README). `WorkflowSpec.steps` is a linear ordered list, not a
  graph — no declared edges/fan-out. The README's real trigger (more than one act, or chained nodes)
  will force the graph shape later; it grows additively from here (edges as an optional field).
- `ocr`/`vlm` kinds are named and homed in the union now for P4B's screen-understanding steps, but carry
  no executor path yet — including them keeps P4B from having to touch the kind union later.

### Rule-7 check (definition of done)
No route, flag, or recipe-touched surface changed, so `skills/` and the CONTRIBUTING recipes have nothing
to keep true this slice (no "add a workflow step kind" recipe exists yet — it belongs with slice 2's
executor, which is what makes a new kind runnable; a contract-only union with no executor is not yet a
followable rail). Contracts: additive only (new document type + example + regenerated schemas). Flag:
none (rule 3 — a document type is not a gated behavior). CODE_MAP: new `config/workflow.ts` tree note +
the "Workflow substrate" future-features row updated to (P4A slice 1 built).

### Tests + verification
`pnpm -r build && pnpm -r test` green before the commit — contracts **52** (+1: the `workflow.default.json`
example validating against `WorkflowSpec`), engine **281**, client **139**, no failures, no flakes seen
(the PHASE3-NOTES drain-timing e2e and client-seam TOCTOU flakes did not appear). Contract-only slice with
no runtime surface to drive — the JSON-Schema validation of the seeded default IS the verification the
executor slice will build on.

### Deferred (out of this slice, by scope)
The executor (slice 2), typed queues (slice 3), the dynamic to-do seam (slice 4) · the condition DSL in
`StepGate` · graph edges/fan-out on `WorkflowSpec` (the DAG, per workflow/README) · a "add a workflow
step kind" CONTRIBUTING recipe (belongs with the executor that makes a kind runnable) · the
`workflow.enabled` flag (slice 2 owns it).

## Slice: Executor v0 — the pipeline runs from the document  *(P4A, Terminal A, branch p4a-workflow)*

The second P4A slice migrates the hardcoded drain/session-end wiring in `api/http.ts` to a
`WorkflowExecutor` that runs the seeded `workflow-default` document, gated by a new `workflow.enabled`
flag (default OFF). OFF leaves the legacy direct-wiring byte-for-byte untouched; ON is behavior-identical.

### Module layout (`apps/engine/src/workflow/`)
- **`executor.ts`** — `WorkflowExecutor`. Pure orchestration over a `WorkflowSpec`; composes INJECTED
  capability seams (`distill`/`transcribe`/`drainNow`/`acts`) rather than importing fabric, so it is
  unit-testable with fakes. Two public methods, one per seam: `runDrain(chunks)` and
  `runSessionEnd(session)`.
- **`documents.ts`** — `WorkflowDocuments`, the house documents-store (mirrors `ActDocuments`/
  `SurfaceDocuments`): seeds `workflow-default` when absent, exposes `active()` / `get(id)`.
- **`defaults.ts`** — `loadDefaultWorkflow()` reads the SAME validated example the contract slice seeded
  (`shared/contracts/examples/workflow.default.json`), not an inlined copy — one source of truth, mirroring
  `api/defaults.ts::loadDefaultFlags`.
- **`index.ts`** — barrel.

### Where the document is read
FRESH per call — `runDrain`/`runSessionEnd` each call `docs.active()`, which reads the store's latest
`workflow-default` (falling back to the shipped default). This is the flags/surfaces hot-edit pattern: a
future document edit takes effect with no engine restart, matching how the drain reads `distill.*` flags
per-drain. The `workflow.enabled` flag is likewise read per-drain / per-session-end in `api/http.ts`, so
the whole executor is hot-flippable.

### How the two paths diverge in `api/http.ts`
- **Drain callback** (`CaptureQueue` processor): the focus→detector routing (`route.detect`) stays
  OUTSIDE the executor and runs on BOTH paths first (routing CONTEXT, not a pipeline step — PHASE3
  distill-hygiene). Then `if (isFlagEnabled(store, 'workflow.enabled')) return executor.runDrain(chunks)`;
  else the legacy `distill.enabled`-gated transcribe?→distill body, unchanged. Both feed the SAME
  `distiller.distillChunks` and the SAME `CaptureQueue`, whose injected `toQueueFailure` classifier does
  the retry-at-idle re-queue on any processor throw.
- **`session.ended` subscription**: inside the existing `void (async () => …).catch(…)`,
  `if (isFlagEnabled(store, 'workflow.enabled')) return executor.runSessionEnd(session)`; else the legacy
  `act.enabled` gate → `drainNow` → `runFollowUpDraft`.
- `runTranscribe` (the stt pre-stage closure) is now shared verbatim by the legacy drain body AND the
  executor's `transcribe` seam, so the two are literally the same call.

### Coalescing (the slice-1 seam contract, enforced here)
`runDrain` reads the drain-triggered steps and folds the distill family into ONE `distillChunks` call:
the `distill` step's when-flag (`distill.enabled`) gates the WHOLE call (no distill step or flag off →
return, exactly like the legacy `if (!distill.enabled) return`); the `transcribe` step is its pre-stage
(runs `transcribeChunks` only when its when-flag is on); `moments`/`index` map to
`{ extractMoments, extractEntities }` (step present AND its when-flag on). `when.flag` gates a single
flag — it does not express the "rides the distill pass" dependency; the coalescing does.

### Behavior-identical — the proof
- **Flag OFF = legacy untouched**: the ENTIRE existing engine suite runs with `workflow.enabled` default
  OFF, so all 43 prior `http.test.ts` cases (drain distill e2e, ≤60s draft e2e, act-OFF-no-draft,
  transcription re-queue) are the OFF-path regression proof — unchanged and green.
- **Flag ON = identical observable behavior**: two new `http.test.ts` e2e mirror the legacy drain and
  draft e2e with `workflow.enabled` ON, through the real spool: (1) drain distills → the `Thursday`
  commitment moment hydrates over `GET /moments`; (2) session-end drains-first → exactly one
  `follow-up-draft` draft, `status: prepared`, `templateId: tpl-followup-default`, retrievable via
  `GET /drafts`.
- **Unit level** (`executor.test.ts`, 13 tests): distill-family gating, coalescing into exactly one call,
  transcribe/distill throw propagation (retry-at-idle), unwired `ocr`/`vlm` + stray drain-act
  skip-with-log, drain-first ordering on session-end, act-off = no-drain-no-act, unregistered-act
  skip-with-log, and the trigger split (session-end act never fires on the drain, drain distill never
  fires on session-end).

### Honest handling of unwired kinds
`ocr`/`vlm` have no executor path (P4B owns invocation): a drain step of that kind is skipped-with-log,
never crashes. An act step wrongly triggered on the drain, and a session-end act with no registered
runner, are likewise skipped-with-log. The default document exercises none of these; they are defensive
against an edited document.

### Rule-7 check (definition of done)
- **Flag** (rule 3): `workflow.enabled` added to `flag.examples.json` (default OFF, engine scope, T1),
  seeded via the existing `ensureDefaultFlags` mechanism — the one new gated behavior this slice adds.
- **Recipes/skills**: grepped `skills/` and `CONTRIBUTING.md` for the drain wiring / flag names — no
  recipe references the drain callback, the session.ended trigger, or the distill.*/act.enabled flags by
  name, so there is nothing there to keep true. (No "add a workflow step kind" recipe exists yet; it is
  still deferred with the configurability work.)
- **Contracts**: no contract change this slice (slice 1 shipped `WorkflowSpec` + the example). No new
  route (see Deferred).
- **CODE_MAP**: `workflow/` tree note updated to "executor v0 built"; `flags/` note + the future-features
  "Workflow substrate" row updated.

### Tests + verification
`pnpm -r build && pnpm -r test` green before each commit. Engine **296** (281 before slice-2 tests +
13 executor unit + 2 workflow ON e2e), contracts **52**, client 138/139.
Flakes seen and confirmed by rerun (both named in the brief / PHASE3-NOTES): the drain-timing e2e in
`http.test.js` and the client-seam TOCTOU in `apps/client` — each passes on rerun, neither touches
workflow code.

### Seam notes for the next slices
- **Slice 3 (typed queues)**: the executor is DOWNSTREAM of the spool — it is the `CaptureQueue`
  processor's body (drain) and the `session.ended` handler (act). It composes `queue.drainNow` via an
  injected `drainNow` seam and never imports the queue. Typed queue kinds (audio/screen/llm-work) and
  per-kind depth are a spool concern; the executor only needs its `distill`/`transcribe`/`drainNow` seams
  to keep their signatures. DO NOT break: the processor-throw → `toQueueFailure` → re-queue path (the
  executor's contract is simply "throw to re-queue"), and the drain-first flush before session-end acts.
- **Slice 4 (task-extract act)**: add a second `kind: act, trigger: session-end` step to
  `workflow.default.json` (e.g. `task-extract`) and register its runner in the `acts` map passed to
  `WorkflowExecutor` in `api/http.ts` (`acts: { 'follow-up-draft': …, 'task-extract': … }`). `runSessionEnd`
  already runs every enabled session-end act in document order after the single drain-first flush — no
  executor change needed for a second act. A to-do document that a later draft step reads as a template
  variable is the new surface; the executor's act-runner signature already passes the `step` so params
  (e.g. the to-do doc id) can be threaded. This second act is ALSO the README's "real trigger" for the
  DAG (more than one act) — but two INDEPENDENT session-end acts still fit the linear list; the graph is
  only forced when one act's input is another act's output.

### Deferred (out of this slice, by scope)
- **GET/PUT `/workflows` resource route** — deferred to keep the slice tight (would need a contracts
  `Routes` additive row + route tests). The read seam (`documents.active()`) is already the hot-editable
  one, so the route drops in later with NO executor change; the document is read-only from the seed for
  now.
- The condition DSL in `StepGate`, graph edges/fan-out on `WorkflowSpec` (the DAG), `compile.ts`
  (Mode.acts → document), and typed queues / dynamic to-do (slices 3–4).

## Slice: Typed queues + envelope/ETA  *(P4A, Terminal A, branch p4a-workflow)*

The third P4A slice puts KINDS on the spool (audio / screen / llm-work), per-kind depth + a backlog ETA
+ the overflow policy in `GET /queue`. It is envelope MATH + policy PLUMBING — NOT cadence control of
capture (that is client-side, not ours). The spool's durability semantics (append, drain, re-queue on
failure) are byte-for-byte untouched; everything added is read-side status + one in-memory rate signal.

### Kind classification — the rule (`queue/kinds.ts`, pure, zero deps)
`classifyKind(chunk)` from `source`/`contentType` ALONE, so P4B's screen chunks land correctly without the
queue importing any P4B/capture code:
- `focus` source → **`focus`** — its OWN bucket, EXCLUDED from every work tally. A focus chunk is ephemeral
  routing context (consumed by the detector, never distilled — the PHASE3 distill-hygiene decision); it is
  never a meaningful backlog. Decision: excluded, NOT trivially counted. It still occupies pending-file
  bytes, which is why `byKind` byte sums can be LESS than `pendingBytes` (documented on the contract).
- `mic` / `system-audio`, or `audio/*` contentType → **`audio`** (the me/them split, mirrors distill's `isAudioChunk`).
- `screen` / `camera`, or `image/*` contentType → **`screen`** (P4B adds the producers; a `screen` source or
  an image payload classifies here with no P4B import — the mandate's explicit ask).
- everything else (calendar / repo / typed text) → **`llm-work`** (text destined for distill; the default).

Source wins over contentType for `mic`/`system-audio` (a `mic` text/plain frame is still `audio`).

### QueueStatus additions (all additive/optional — the PHASE3 INVOKE-RESILIENCE precedent)
Exact new fields on `QueueStatus` (`shared/contracts/src/api/payloads.ts`):
- **`byKind?: { audio, screen, 'llm-work' }`** where each is **`QueueKindDepth { pendingChunks, pendingBytes }`**.
- **`eta?: BacklogEta`** = `{ basis: 'observed'|'none', etaMs?, caughtUpBy?, drainRateChunksPerSec?, measuredTokPerSec? }`.
- **`overflow?: OverflowState`** = `{ policy: 'queue-for-idle'|'degrade-cadence'|'drop', enforced }`.
Four new `$id`'d schemas registered (`QueueKind`, `QueueKindDepth`, `BacklogEta`, `OverflowState`); schemas
regenerated 60 → 64; `examples/queueStatus.typed.json` seeded + validated. The pre-existing
`queueStatus.empty/failed` examples stay valid (new fields optional).

### The ETA design (`queue/eta.ts`, pure) — inputs + honest unknowns
`projectEta({ backlogChunks, samples, now, measuredTokPerSec? })`:
- **Primary input = observed drain history.** The spool records one `DrainSample { chunks, ms }` per
  SUCCESSFULLY drained file — `chunks` = the file's WORK-chunk count (focus excluded, so numerator and the
  focus-excluded backlog denominator share units), `ms` = the processor duration. Kept in a 20-deep in-memory
  ring (operational state, same justification as `lastFailure`/`drainedFiles` — no user intent, recomputed,
  no version history; NOT a document). Rate = Σchunks / Σms → `etaMs = backlogChunks / rate`,
  `caughtUpBy = now + etaMs`.
- **Honest unknown (the mandate).** No samples, or samples with zero chunks / zero time → **`basis: 'none'`
  with NO etaMs/caughtUpBy** — an unknown is unknown, never a fabricated ETA. Empty backlog → already caught
  up (`etaMs 0`, `caughtUpBy = now`).
- **`measuredTokPerSec`** (the active/first-in-fabric-order llm endpoint's benchmarked tok/s, fabric §8
  `measured`) is injected READ-ONLY from `api/http.ts` and **echoed as the envelope's measured side** — it is
  NOT the ETA basis in v0. Converting tok/s → a chunk ETA needs a tokens-per-chunk model that does not exist
  honestly yet (deferred; `basis` union has room for a future `'measured'` member additively).
- **ETA is OVERALL, not per-kind.** The drain processes whole files that MIX kinds, so the observed rate is a
  mixed-kind chunks/sec. A per-kind ETA would need per-kind drain accounting — deferred, stated on the contract.

### Overflow — what is REAL vs DECLARED
The policy is DATA threaded from the active mode (`Mode.overflow` `queue|degrade|drop`) → the status
tri-state (`queue`→`queue-for-idle`), surfaced via a read-only seam injected from `api/http.ts`. The
`enforced` boolean encodes real-vs-declared directly in the data:
- **`queue-for-idle` (default) — REAL, `enforced: true`.** It IS today's behavior: append + drain at idle,
  never lose capture. No new code needed to honor it.
- **`degrade-cadence` — DECLARED, `enforced: false`.** Capture cadence is a CLIENT concern; the engine cannot
  and must not throttle the client (explicitly out of scope per the brief). Recorded-but-inert signal.
- **`drop` — DECLARED, `enforced: false`.** Dropping deliberately violates the spool's whole reason to exist
  (never lose capture). Enforcing a backlog cap by dropping is a real behavior change that needs explicit
  product sign-off + a threshold source (no `maxPendingBytes` config exists today); deliberately NOT built.
So v0 overflow is honest surfacing, not enforcement beyond the safe default. Deferred: `drop` backlog cap
(with a threshold config), any engine-side degrade signalling the client acts on.

### Seams kept intact (slice-2 constraints)
- The executor is DOWNSTREAM of the spool and untouched: `distill`/`transcribe`/`drainNow` seam signatures
  unchanged, processor-throw → `toQueueFailure` → re-queue (retry-at-idle) unchanged (the sample is recorded
  only on SUCCESS, after the processor returns — a re-queue records no sample, correctly), drain-first flush
  before session-end acts unchanged.
- The queue keeps ZERO fabric/invoke/store imports — `kinds.ts`/`eta.ts` import only contract TYPES; measured
  tok/s and overflow arrive through injected function seams (the `describeFailure` precedent).

### Performance note (accepted for v0, optimization deferred)
`status()` now parses the pending files to tally per-kind depth (O(pending bytes) per call, and it is called
after every capture via `queue.updated`). Accepted because the backlog is normally empty (files drain
immediately via `scheduleDrain`) and only grows when the model is slow/down; files are small JSONL. A future
incremental-counter optimization (update per-kind counts on append/drain instead of re-parsing) is deferred.

### Rule-7 check (definition of done)
- **Contracts**: additive only (`byKind`/`eta`/`overflow` optional on `QueueStatus`; four new sub-schemas).
  Schemas regenerated (64), `queueStatus.typed.json` added + validated, existing examples still valid.
- **Flag** (rule 3): NONE. This adds no gated engine-processing behavior — it is read-side status enrichment
  plus one in-memory rate signal; `overflow.enforced` for the non-default policies is inert by design, not a
  flag. Consistent with the no-flag line for status/resource surfaces.
- **Recipes/skills**: grepped `skills/` and `CONTRIBUTING.md` for `GET /queue` / `spool` / `QueueStatus` /
  `byKind` / `pendingFiles` — NO reference anywhere, so nothing to keep true there.
- **CODE_MAP**: `queue/` tree note updated (kinds.ts/eta.ts/byKind/eta/overflow) + a new "Typed queues +
  envelope/ETA" built row; the "Backlog analytics surface" P7 row annotated (the eta module now exists).
- **No route added/changed** (`GET /queue` already existed; only its payload grew additively).

### Tests + verification
`pnpm -r build && pnpm -r test` green before each commit. Contracts **53** (+1: `queueStatus.typed.json`),
engine **312** (296 slice-2 baseline + 12 pure-module: `kinds.test.ts` 7 + `eta.test.ts` 5, + 4 `spool.test.ts`:
per-kind depth incl. focus-exclusion, eta none→observed with a backlog, overflow+measured seam surfaced,
absent-overflow additive), client 139. On the clean run all three suites were fully green; the pre-listed
flakes (drain-timing e2e in `http.test.js`, client-seam TOCTOU) each pass in isolation (http.test.js 45/45
alone). LIVE check: `createEngineApp` on :8931, POSTed mic/system-audio/screen/calendar/focus chunks, `GET
/queue` returned the additive `byKind`/`eta`/`overflow` shape correctly (backlog 0 because the no-op drain
cleared immediately; the non-empty backlog path is unit-covered).

### Seam notes for slice 4 (task-extract act + dynamic to-do)
- **Nothing in queue/status needs to change for slice 4.** A second `kind: act, trigger: session-end` step
  (`task-extract`) rides the SAME executor session-end seam (slice-2 note) — it does not touch the queue.
- **`byKind`/`eta` will surface a to-do act's cost only insofar as it drains chunks.** A `task-extract` act
  runs on session-end AFTER the drain-first flush, so it is not a queue-drain processor and produces no
  `DrainSample`; the ETA is unaffected. If slice 4 ever makes to-do extraction a DRAIN step (it should not —
  it is an act), it would then count as `llm-work` and feed the rate like any other work chunk.
- **Do NOT break**: the `DrainSample` is recorded ONLY on processor success — keep the re-queue path
  (throw → no sample) as-is so a failing model does not poison the drain-rate with 0-chunk fast "successes".
- The to-do DOCUMENT slice 4 adds is a store surface, not a queue concern; `GET /queue` stays a pure spool
  status view (no workflow/act state leaks into it — the executor/queue separation from slice 2 holds).
