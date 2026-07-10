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
- **GET/PUT `/workflows` resource route** — RESOLVED by the P4-T1 slice below (contracts `Routes` rows +
  `WorkflowDocuments.save` + the three handlers, NO executor change, as this note predicted).
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

## Slice: Dynamic to-do seam (prompt engine v0)  *(P4A, Terminal A, branch p4a-workflow)*

The fourth and final P4A slice lands the product's **constrain/unconstrain loop**: a `task-extract` act
CONSTRAINS a meeting's distillates+moments into a structured, editable to-do array; a follow-up draft
UN-CONSTRAINS it back into prose via a `{{todo}}` template variable. Everything is a document: the to-do
list is a versioned, editable `TodoList` a user can PUT and the next draft reflects.

### Contracts added (all additive)
- **`TodoList`** (`config/todo.ts`): the editable session to-do document. House envelope (`id·name·version·
  description?`) + `sessionId·workspaceId·items[]`, keyed in the store by session id.
- **`TodoItem`**: `{ id, text, done?, provenance?, createdAt }` — id/createdAt server-stamped (the model
  controls only `text`), `done` a user checkmark extraction never sets.
- **`TodoProvenance`**: `{ sessionId?, distillateId?, momentId? }` — the extraction trail (all optional; a
  user-added item has only its session). Registered in `index.ts`, seeded `examples/todo.session.json`,
  schemas regenerated 64 → 67.

### DECISION — the drain-vs-session-end tension: task-extract rides the DRAIN as a best-effort ACT
The mandate's design tension (does task-extract accumulate DURING the session on the drain, or run once at
session-end?) is resolved in favor of the **drain**, because the core value ("a mid-meeting draft
live-updates from ACCUMULATED follow-ups") requires the to-do to grow across the meeting — session-end-only
cannot demonstrate accumulation. Reconciled with slice 3's "keep to-do extraction an act, not a drain
stage" warning as follows:
- task-extract is a `kind: act, trigger: 'drain'` step. The executor's `runDrain` runs drain-triggered acts
  AFTER the coalesced distill pass, via a NEW `drainActs` map whose runner signature is `(chunks, step)` —
  a drain has no single live session, so the runner derives its affected `(workspaceId, sessionId)` pairs
  from the batch (like the distiller's `groupBySession`). This is the honest signature divergence from the
  slice-2 `acts` (session-end) map, which stays `(session, step)`.
- It is an ACT, not a chunk-consuming drain STAGE: it consumes no drained chunks and produces no distillate;
  it reads the session's ALREADY-persisted, accumulated distillates+moments and merges into the to-do doc.
- **BEST-EFFORT**: a runner throw is CAUGHT + logged, never re-propagated. The slice-2/3 seam "throw →
  re-queue" is for distill/transcribe (chunk work that must retry); a task-extract failure must NOT re-queue
  the batch, because the batch already distilled — a re-queue would re-run distill and duplicate distillates.
  `DrainSample` is still recorded ONLY on processor success (unchanged) — a caught act throw leaves the drain
  a success, so a failing extractor never poisons the drain rate with a re-queue.
- **The DrainSample WART (stated honestly).** When `act.tasks` is ON, task-extract's llm call happens inside
  the drain processor, so its time IS included in the file's `DrainSample.ms` → the observed drain rate is a
  mixed cost and the ETA slightly inflates. This is DECLARED, not hidden: (1) `act.tasks` is OFF by default,
  so the default ETA/`byKind`/`overflow` from slice 3 is byte-for-byte unpolluted (the slice-1/2/3
  behavior-identical proof holds); (2) when a user opts in, the extra time genuinely IS work happening on the
  drain, so counting it is defensible, just conflated. The clean fix (bill only the distill sub-call, or run
  drain-acts outside the sample-timed region) needs the spool to distinguish billable sub-work — deferred.
- The alternative slice-3 blessed (session-end only, no pollution, reuse `(session,step)`) was rejected only
  because it cannot show mid-meeting accumulation. `TaskExtractor.extractForSession` is public, so a future
  session-end or mid-meeting-draft trigger can call it without the drain if that tradeoff is ever wanted.

### DECISION — the to-do document shape: kind `todo-list`, key = session id, in _meta.db
`TodoDocuments` mirrors `SurfaceDocuments`/`WorkflowDocuments`: versioned records in `_meta.db` via
`LayoutStore`, kind `todo-list`, **key = the owning session id** (so it is addressable as `/todos/:sessionId`
and the `id` field equals the session id). `save()` stamps `version` = latest+1 and contract-validates the
body before write; `upsert()` merges extracted candidates into the existing list (creating it if absent).
NOT seeded — a session has no to-do until its first extraction or first user edit.
- **Per-session (not per-workspace)**: a mid-meeting draft reflects THIS meeting's follow-ups; per-session is
  the natural grain and matches how the draft is per-session.
- **WART (stated)**: these documents live in the workspace-GLOBAL `_meta.db` keyed by session id, NOT in the
  per-workspace record DBs where distillates/moments/drafts live. That is correct for a *document* (flags,
  surfaces, modes, workflows are all global config docs) — the to-do is a document, not a record — and
  session ids are globally unique uuids, so the key never collides. A move-session (reroute) does NOT carry
  the to-do doc today (records move; this global config doc does not) — noted as deferred.

### The `{{todo}}` mechanism — prompt engine v0
One well-defined dynamic-document variable, resolved at act-compose time. `composeFollowUpDraft` takes an
optional `todo: TodoItem[]`; `renderTodo(items)` produces the `{{todo}}` value: **empty → `''`** so the
template section is HONESTLY OMITTED (there is no conditional in `interpolateTemplate` — a dumb `{{var}}`
replace where unknown/empty resolves to ''; the empty-state is expressed by rendering nothing), **non-empty →
a titled bullet list** ("Accumulated follow-ups so far…", `done` items struck `[x]`). The default follow-up
template body gains a `{{todo}}` block + an instruction to fold the running to-do into next-steps. The Actor
reads the session's to-do doc FRESH per draft (`TodoDocuments.get`), so a user's PUT-edited list is what THIS
draft interpolates.
- **What a fuller prompt engine adds later (deferred)**: conditionals/iteration/partials in the template
  grammar, whitespace control, a declared variable catalogue with types, and per-variable resolvers (so a
  template can reference `{{moments.commitments}}` or `{{entities.relevant}}`, not just the one to-do var).
  v0 is deliberately ONE variable resolved from ONE document — the smallest real instance of the loop.

### The constrain/unconstrain demonstration (which proof shows what)
- **End-to-end over the real spool** — `http.test.ts` "task-extract accumulates a to-do over the drain, the
  draft un-constrains it via {{todo}}, and the doc is editable": whole loop ON (`workflow.enabled` +
  `distill.enabled` + `distill.moments` + `act.enabled` + `act.tasks`); capture → the DRAIN's task-extract
  ACCUMULATES an item, visible MID-MEETING over `GET /todos/:sessionId` → session end drains-first (final
  extract) then the follow-up draft body CONTAINS that item (the draft interpolated `{{todo}}`) → a user PUTs
  an edited `items` array and `GET` reflects it version-bumped (the editable document over HTTP).
- **The user-edit → NEXT draft proof** — `act/draft.test.ts` "a user-edited to-do doc is reflected in the
  next draft": a to-do doc is `save()`d with a hand-added item (what `PUT /todos/:id` does), then
  `Actor.runFollowUpDraft` composes a draft whose body contains the user's item. This is the editable-document
  half done at the compose level because there is **no re-draft route** in the HTTP surface yet (a draft runs
  once at session-end); a mid-meeting-draft / re-draft trigger is deferred (see below).
- **Unit** (`act/todo.test.ts` 10, `draft.test.ts` +2, `executor.test.ts` +5): merge dedupe (normalized-text,
  preserves user `done`), compose empty/parse-text·task·string/dropped/unparseable-resample, `TodoDocuments`
  version-bump, `TaskExtractor` accumulate-across-drains + empty-session-no-doc, `{{todo}}` non-empty-reaches /
  empty-omitted, and the executor drain-act gates (ON-runs / OFF-silent / no-runner-skip-with-log /
  throw-caught-best-effort / distill-OFF-no-run).

### New flag + routes
- **Flag** `act.tasks` (default OFF, engine, T1) — the one new gated behavior (CONTRIBUTING rule 3), seeded via
  `flag.examples.json`. task-extract runs only under `workflow.enabled` + `act.tasks` (+ `distill.enabled`,
  since it rides the distill pass — distill OFF → the drain returns early → task-extract does not run).
- **Routes** (additive, phase 4, no flag — resource routes like `/drafts`/`/layouts/surfaces`): `GET /todos`
  (list all), `GET /todos/:id` (one, 404 if none), `PUT /todos/:id` (edit — validated, sessionId must match
  the route). The user can now SEE the to-do list; the HUD renders it later off these.

### Dedupe wart (stated)
Merge dedupe is normalized-text equality only (trim/lowercase/collapse whitespace — identical to store's
`normalizeEntityName`). No stemming, no paraphrase/semantic dedupe: "Send Dana the deck" and "Send the deck
to Dana" are two items. Good enough for v0; a semantic dedupe (embedding-based, or an llm merge pass) is
deferred. Existing items (incl. user edits + `done`) are always preserved across a re-extraction — the
dedupe only suppresses NEW candidates, it never mutates or drops what is already there.

### Rule-7 check (definition of done)
- **Flag** (rule 3): `act.tasks` added (the one new gated behavior). The routes are resource read/write, no
  flag (consistent with `/drafts`, `/layouts/surfaces`).
- **Recipes/skills**: grepped `skills/` + `CONTRIBUTING.md` for `task-extract|todo|{{|follow-up|act kind|
  /drafts|prompt engine`. The only hit is the Tier-B table's "new act kind" line — a recipe that STILL does
  not exist (deferred since slice 2). No `skills/` file references acts, templates, drafts, or the to-do; the
  add-a-block skill and the block/settings/watcher/runtime recipes are untouched by this slice, so nothing
  there is stale. task-extract's shape (a `drainActs` runner + a document + a gating flag) is now a de-facto
  pattern a future "add an act kind" recipe could codify — noted as deferred, not written (a recipe is a rail
  a local model follows blindly; writing one before a second act proves the pattern would be premature).
- **Contracts**: additive only (`TodoList`/`TodoItem`/`TodoProvenance` + example + regenerated schemas; three
  additive `/todos` Routes rows). Existing examples still validate.
- **CODE_MAP**: `config/todo.ts` note on the config row; `act/` row updated (task-extract BUILT); a new
  "Dynamic to-do seam (prompt engine v0)" built row; `flags/` note (`act.tasks`).

### Tests + verification
`pnpm -r build && pnpm -r test` green before each commit. Contracts **54** (+1: `todo.session.json`), engine
**330** (312 slice-3 baseline + 10 `act/todo.test.ts` + 2 `draft.test.ts` + 5 `executor.test.ts` net + 2
`http.test.ts` — the to-do e2e + the `/todos` route test − 1 removed stray-act executor test), client **139**.
Flakes: the pre-listed drain-timing e2e / client-seam TOCTOU did not recur on the clean per-suite runs; a
network-probe test (`POST /fabric/test`) timed out ONCE under `pnpm -r test` sandbox network stall and passed
in 37 ms in isolation (environmental, unrelated to this slice — not touched here). LIVE check: `createEngineApp`
on :8931 — `/routes` lists the three `/todos` rows, `/flags` carries `act.tasks` (default false), `GET /todos`
→ `[]`, `GET /todos/none` → 404, `/contracts` lists `TodoList`/`TodoItem`. Killed after.

### Deferred (out of this slice, by scope)
- A **re-draft / mid-meeting-draft trigger** (so an edited to-do re-composes a live draft over HTTP without
  ending the session) — `TaskExtractor.extractForSession` + `Actor.runFollowUpDraft` are both public and ready;
  only a route/trigger is missing.
- **Semantic dedupe** (embedding/llm merge) over the normalized-text v0.
- **The DrainSample clean fix** (bill only the distill sub-call when a drain act rides the pass).
- **Carrying the to-do doc on move-session** (reroute) — records move today; this global config doc does not.
- **A fuller prompt engine** (conditionals/iteration/partials, a typed variable catalogue) over the one
  `{{todo}}` variable.
- **An "add an act kind" CONTRIBUTING recipe** — the pattern now has two acts (follow-up-draft, task-extract);
  a recipe could codify `drainActs`/`acts` + document + flag, but is left until a third act pressures it.

### P4A CLOSE-OUT + the P4A×P4B joint slice
P4A (all four slices: WorkflowSpec contract → executor v0 → typed queues+ETA → dynamic to-do seam) is
COMPLETE on branch `p4a-workflow` in the openinfo-p4a worktree, pending merge to main after P4B settles. What
the small **P4A×P4B joint slice** (screen understanding as a workflow step) will need from P4A's side:
- The executor's `ocr`/`vlm` drain kinds are still skip-with-log (no runner). The joint slice registers their
  runners the way this slice registered `task-extract` — but as DRAIN STAGES (chunk-consuming, produce a
  distillate/screen-result), NOT best-effort acts, so they DO feed the `DrainSample`/`byKind` like distill.
  Use the `drainActs` best-effort pattern ONLY for derived acts; screen OCR/VLM invocation is real drain work.
- Screen chunks already classify to the `screen` queue kind (slice 3, no P4B import) — the executor just needs
  P4B's `invokeOcr`/`invokeVlm` injected as seams (mirroring the `distill`/`transcribe` seam injection) and the
  `ocr`/`vlm` steps' `slot`/`when` honored. The `WorkflowStep` contract already homes `ocr`/`vlm` kinds.
- One mount concern only: `api/http.ts` is P4A-owned; the joint slice adds the OCR/VLM seam wiring there
  (P4B adds at most one router mount line per its own charter). No contract change should be needed — the
  WorkflowStep kinds and screen-chunk records already exist on both branches.

## PHASEB — screen capture + OCR/VLM invocation  *(P4B, Terminal B, branch `p4b-screen-ocr`)*

The flagship use case (OSS-contribution screen watching) and the least-built element: OCR/VLM
existed only as contract slot names; nothing invoked them and screen capture was pending. P4B is the whole
vertical — this note is self-contained across its four slices (contracts, fabric invocation, client
capture, and the slice-4 processor+router that stitches capture → OCR → surfaces).

### Contracts
- **`ScreenFrameMeta`** (`records/screen.ts`, slice 1): a frame is an IMAGE riding the EXISTING
  `CaptureChunk` transport (`source:'screen'`, `encoding:'base64'`, a `ScreenContentType` mime) — no new
  chunk type. Its typed descriptor (displayId/width/height/scale, + a future `deltaScore` Δ-gate hook)
  travels as a COMPANION `source:'screen'` utf8/json chunk, exactly the way a `FocusSignal` does — emitted
  adjacent to the image chunk at the next sequence, correlated by capture order. `capturedAt` is not
  restated (it already lives on the CaptureChunk).
- **`OcrResult`** (`records/ocr.ts`, slice 1): the screen-understanding analogue of a `Distillate` —
  id/sessionId/workspaceId/sourceChunks/text/provenance(slot `ocr`|`vlm`, endpoint, model?)/schemaVersion/
  createdAt, plus an OPTIONAL `blocks[]` (per-region text+confidence+pixel box) present for a region-aware
  OCR runtime and absent for a VLM (prose). `OCR_RESULT_SCHEMA_VERSION = 1`.
- **`OcrInvokeParams`/`VlmInvokeParams`** (`config/invoke.ts`, slice 1): engine-agnostic invoke requests
  (image + contentType, + the VLM prompt) — name WHAT to understand, never WHICH endpoint.
- **`ScreenStatus`** (`api/payloads.ts`, slice 4): the processor's health — `enabled` + processed/blank/
  skipped/failed counters + a `QueueFailure[]` ring. The processor rides capture INGEST, not the queue
  drain, so its health has no home on `QueueStatus`; this is that home. Routes: `GET /screen/results`
  (`OcrResult[]`) + `GET /screen/status` (`ScreenStatus`), phase 4. Schemas regenerated (+1: ScreenStatus).

### Fabric
- **`api:'paddle-serving'`** dialect + widened `AggregateInvokeError` slot to `ocr`/`vlm` (slice 2).
- **`invokeOcr` / `invokeVlm`** (`fabric/invoke.ts`, slice 2) — mirror `invokeLlm`/`invokeStt` (fabric-order
  fall-through, first-healthy-wins, classified failures, keyRef→Bearer at invoke time). `invokeVlm`: an
  OpenAI-compat VISION chat (text part + `image_url` data URI). `invokeOcr`: an http `paddle-serving`
  endpoint speaks the PaddleHub `POST /predict/ocr_system` `{"images":[b64]}` contract (region-aware
  blocks); an http `openai-compat` endpoint filling the ocr slot falls back GRACEFULLY to VLM-transcription
  with a default recognition prompt (prose, no blocks — the dialect field decides). Empty text `''` is a
  normal blank-frame outcome, never an error. Bench measures the ocr+vlm slots like every other slot.

### Client capture
- Screen is a THIRD capture source (`protocol.ts`), opt-in via `cfg.screenEnabled` (`OPENINFO_SCREEN`).
  Captured in the MAIN process (`desktopCapturer` polled at `cfg.screenIntervalMs`,
  `NativeImage.toJPEG(70)`, physical-pixel thumbnail for retina) — NOT a hidden renderer, so it does not
  ride the `capture:*` IPC. Each frame ships as TWO CaptureChunks: the image (`image/jpeg`, base64, seq N)
  and its companion `ScreenFrameMeta` (`application/json`, utf8, seq N+1), both `scr-` id-prefixed,
  same `capturedAt`. Screen-Recording TCC: an empty grab (grant pending) skips the frame, never ships
  black. `ws.ts` now frames RFC 6455 extended payload lengths so a large frame broadcast can't crash the
  event feed.

### Screen processor + router  *(slice 4, this terminal's final slice)*
- **Module home:** a new `apps/engine/src/screen/`. CODE_MAP §3 previously homed OCR at `distill/ … ocr`;
  reconciled honestly — the fabric OCR/VLM *invocation* lives in `fabric/invoke.ts` (with the other
  slots), and the screen *processor + router* get their own `screen/` module (one concern per file:
  `processor.ts`, `router.ts`, `registry.ts`, `index.ts`). Screen understanding is not the transcript
  distiller — a frame is understood by OCR, not by the rolling-merge distiller — so it is not a `distill/`
  stage.
- **Processor** (`screen/processor.ts`): subscribes to `capture.received`, gated per-frame on the new
  `screen.ocr` flag (read like the drain's distill flags — flip needs no restart). It acts ONLY on
  `source:'screen'` IMAGE chunks; the companion `application/json` meta chunk is skipped-and-counted;
  non-screen chunks are ignored. It invokes the fabric `ocr` slot (`invokeOcr` — paddle-serving OR the
  openai-compat VLM fallback; it builds NO slot-picking policy beyond what invoke already does), stamps a
  full `OcrResult` (blocks carried through when present) and persists it, then constructs a `Distillate`
  DIRECTLY (no extra llm pass) so the standard surfaces read the screen text. Runs INDEPENDENTLY of
  `distill.enabled` (screen ≠ transcript).
- **Empty-frame policy (decision):** empty recognized text is a BLANK frame — persist NEITHER an OcrResult
  NOR a distillate (nothing to say) but COUNT it (`blank`), so `/screen/status` stays honest about frames
  seen. Cheapest honest choice; a blank OcrResult would be DB noise no surface wants.
- **Distillate voice (decision):** `Distillate` requires a voice vector, but no voice/register pass runs
  over OCR text (it is transcription, not rewriting). The honest fill is `scope:'global'` + `NEUTRAL_DIALS`.
  `windowStart == windowEnd == the frame's capturedAt` (a single frame is one instant).
- **Errors:** `process()` NEVER throws — an `AggregateInvokeError` is classified (via
  `describeInvokeFailure`) into a bounded `QueueFailure` ring exposed by `status()`; any other error is
  logged. The wiring subscribes fire-and-forget (`void process(chunk)`), so a slow/failing OCR can neither
  block nor 500 the ingest path (`bus.publish('capture.received')` awaits its subscribers).
- **Event naming (decision):** the processor publishes `distillate.updated` (so the EXISTING WS feed +
  surfaces see the frame's understanding) and an engine-internal `ocr.completed` (the raw `OcrResult`).
  `ocr.completed` is deliberately NOT added to the contract WS `Events` map — there is no WS consumer for
  it yet, and adding a WS broadcast would cost a second line in the P4A-owned `http.ts` (forbidden). A
  future screen-aware HUD surface can subscribe on the internal bus and gain a broadcast then.
- **Router** (`screen/router.ts`): `GET /screen/results?workspace=&session=` (persisted OcrResults;
  accepts `sessionId` too) + `GET /screen/status`. Read routes ⇒ NOT flag-gated (CONTRIBUTING rule 3 — the
  DATA is gated upstream by `screen.ocr`). Reaches the processor's in-memory status via a `WeakMap(store →
  processor)` bridge (`registry.ts`), because the router is called with only the HandlerContext and the
  processor is constructed after `createEngineApp`. Structural context type ⇒ the router never imports the
  P4A-owned `http.ts`.
- **Store** (`store/workspaces.ts`): a new `ocr_results` table + `saveOcrResult`/`listOcrResults` mirroring
  the distillate methods; `moveSession` copies+deletes OcrResults with a rerouted session (session-keyed,
  like distillates/drafts). Only `store/` opens a DB (rule 2).

### Wiring
`wireScreenOcr(app)` in `screen/index.ts`, called from `main.ts` AFTER `createEngineApp` (out of the
P4A-owned `http.ts`). It reconstructs `FabricDocuments` + `FileSecretStore` over the app's store EXACTLY
as `http.ts` does (same DB ⇒ same active-profile live fabric, same chmod-600 secret store), builds the
processor, registers it in the WeakMap, and subscribes it to `capture.received`. No `LocalRuntimeManager`
is constructed here — a managed local ocr/vlm runtime is future (invokeOcr falls through `local` endpoints
gracefully; the real v0 paths are http paddle-serving / openai-compat, which need none). The single P4B
line in `http.ts` is the `/screen` mount (`handleScreen`), added as its own commit.

### Tests
Contracts **58** (unchanged mapping; ScreenStatus has no example file). Engine **315** (+8 screen:
7 processor unit — recognizes via the fabric ocr slot over a fake paddle → OcrResult(+blocks)+distillate
persisted+published; flag off ⇒ untouched, invoke never called; companion meta chunk skipped+counted;
empty text ⇒ blank (neither record); non-screen chunk ignored; AggregateInvokeError classified into the
ring and NOT thrown; ring bounded to failureRingSize keeping newest — plus 1 e2e: engine up → PUT /fabric
(ocr→fake paddle) → PUT /flags/screen.ocr → POST /capture/screen (image + meta) → poll GET /screen/results
→ assert OcrResult + the distillate on the standard feed (there is NO /query distillates source — the
"assert distillate via /query" brief was inaccurate; distillates surface via `distillate.updated` + store)
→ GET /screen/status = processed:1/skipped:1/failed:0). `pnpm -r build && pnpm -r test` green; the one
failure seen under `pnpm -r test` was the pre-existing client `engine-link/seam` TOCTOU flake (11≠10),
which passes 3/3 in isolation — unrelated to engine-only P4B changes.

### Live verification (what was real, what was faked)
Engine run STANDALONE from the worktree dist on port **8799** (`OPENINFO_DATA=<tmp> OPENINFO_PORT=8799
node apps/engine/dist/main.js`; wired via `main.js`'s `wireScreenOcr`), NO workflow executor.
- **REAL:** the OCR model. Probed localhost — LM Studio live on :1234 serving `glm-ocr@q8_0` (a genuine
  GLM-OCR vision model). Wired it into the live fabric's `ocr` slot (`PUT /fabric`, api `openai-compat`);
  invokeOcr took the VLM-transcription fallback path.
- **FAKED:** the frame. macOS `screencapture -x -t jpg` was TCC-denied here ("could not create image from
  display"), so per the plan I fell back to a generated fixture — a PIL-rendered 640×200 JPEG reading
  "OpenInfo P4B live OCR check".
- **Result:** `POST /capture/screen` (ack ok) → glm-ocr recognized the text verbatim →
  `GET /screen/results` returned one OcrResult (`text: "\nOpenInfo P4B live OCR check"`, slot `ocr`,
  endpoint `lmstudio-glm-ocr`, model `glm-ocr@q8_0`); `GET /screen/status` = enabled, processed:1,
  failed:0. Direct sqlite check of the workspace DB confirmed BOTH the `ocr_results` row and the companion
  `distillates` row (text trimmed to "OpenInfo P4B live OCR check", slot ocr, window == capturedAt).
  Engine killed after (confirmed down).

### Rule-7 check (definition of done)
- **Routes:** two READ routes added (`/screen/results`, `/screen/status`) — declared in
  `contracts/api/routes.ts`. Read routes are NOT flag-gated (rule 3). No skill references them (the one
  shipped skill, `add-a-block`, only enumerates the flags/routes ITS recipe touches — surface documents —
  and no recipe adds an engine READ route), so nothing in `skills/` goes stale.
- **Flag:** `screen.ocr` added (default OFF, engine, T1) — it gates the screen-OCR PROCESSING behavior
  (rule 3). No skill enumerates flags beyond `add-a-block`'s upstream-flag note for block SOURCES; this
  slice adds no block source, so that note needs no `screen.ocr` entry (it would, only if a later slice
  adds an OCR-backed block source — recorded as the one conditional touch-point).
- **Recipes:** no CONTRIBUTING recipe references the new surfaces; the nearest ("add a fabric runtime")
  is about endpoints, already true for the paddle/VLM dialects from slice 2. Nothing to update.
- **CODE_MAP:** §1 tree gains the `screen/` module + the client screen-capture note; §3 reconciles the
  `distill/ … ocr` placeholder and adds rows for the screen processor/router, the `screen.ocr` flag, and
  the client screen source. Done in this same docs commit.

### Deferred (out of this slice, by scope)
- **Δ-gating** — the `ScreenFrameMeta.deltaScore` hook exists but no gate reads it; the client captures on
  a fixed cadence (screenshot-diff threshold vs OCR cost is the `delta-gate` spike, CODE_MAP §4).
- **`runtime:'paddle'` managed-local** — a spawned PaddleOCR runtime (invokeOcr falls through `local` ocr
  endpoints today; no `RUNTIME_SPECS` entry). Same future as a managed local vlm; no `LocalRuntimeManager`
  in the screen wiring until then.
- **Workflow-step integration** — DONE, see "## P4A×P4B JOINT SLICE" below.
- **`capture.received` payload slimming** — `http.ts` rebroadcasts the FULL CaptureChunk (incl. the base64
  image) over the event feed; slimming that is an http.ts-owned (P4A) concern, not this branch's.
- **A distillates read route / `/query` distillates source** — screen distillates currently surface only
  via `distillate.updated` + the workspace DB; a first-class read surface is unscoped here.

## P4A×P4B JOINT SLICE — screen understanding as a workflow drain step  *(branch `p4ab-joint`, DONE 2026-07-08)*

Folds P4B's screen understanding into P4A's workflow executor as the `ocr`/`vlm` drain stage (the tail
listed in both P4A's CLOSE-OUT and P4B's deferred). No contract change — `WorkflowStepKind` already homed
`ocr`/`vlm` and the screen-chunk records already exist on both sides.

### What landed
- **Executor drain stage** (`workflow/executor.ts`): a new injected `recognizeScreen` seam (type
  `ScreenRunner`), driven for each `ocr`/`vlm` drain step. It runs at the TOP of `runDrain` — before the
  distill gate — in document order among the screen steps, gated per-step by `when`. Mirrors the
  `distill`/`transcribe` seam injection; NOT the best-effort `drainActs` pattern. A gated-ON step with no
  seam registered skips-with-log; gated-OFF is silent (behavior-identical default).
- **Processor drain entry** (`screen/processor.ts`): `runOnDrain(chunks, step)` recognizes the batch's
  `source:'screen'` IMAGE frames through the slot the STEP names (`ocr` → `invokeOcr`, `vlm` → `invokeVlm`
  with `step.params.prompt` or a default screen prompt), persisting the SAME `OcrResult` + `Distillate` the
  ingest path builds — the build+persist+publish body is extracted into a shared `persist()` so both paths
  emit byte-identical records. Counters feed `/screen/status` for the workflow path too.
- **Wiring** (`api/http.ts`): the seam is `(chunks, step) => getScreenProcessor(store)?.runOnDrain(...)`.
  The processor is wired POST-`createEngineApp` by `wireScreenOcr` (P4B's charter keeps screen wiring out
  of this P4A-owned file), so the seam reaches it LAZILY at drain time through the SAME store-keyed
  registry (`screen/registry.ts`) bridge the `/screen` router already uses — one processor instance, shared
  by the router (status) and the executor (drain). No new construction in `http.ts`.
- **Seeded default** (`shared/contracts/examples/workflow.default.json`): a `screen-ocr` step (kind `ocr`,
  slot `ocr`, `when: screen.ocr`) added before `transcribe`. Behavior-identical when `workflow.enabled` OFF
  (the executor is inert; the legacy ingest path is untouched). No `vlm` step in the default — the default
  mirrors "today's pipeline" (screen understanding = OCR, VLM-fallback inside `invokeOcr`); a `vlm` step is
  available for a user who edits the workflow, but shipping both `ocr`+`vlm` in the default would recognize
  every frame twice.

### The double-processing rule (the decision the hand-off asked for)
**Screen understanding has exactly ONE owner, selected by `workflow.enabled`** — the same master switch that
already routes distill/act between the legacy direct-wiring and the executor:
- `workflow.enabled` **OFF** → the ingest-time processor owns it (rides `capture.received`, gated
  `screen.ocr`) — the legacy P4B path, untouched.
- `workflow.enabled` **ON** → the executor's `ocr`/`vlm` drain stage owns it (gated `screen.ocr`); the
  **ingest subscription DEFERS** (`screen/index.ts`: `if (isFlagEnabled(store,'workflow.enabled')) return`
  before `process()`), so a frame is never recognized twice.

Why this rule (smallest coherent): it reuses the existing "`workflow.enabled` is the legacy↔executor master
switch" pattern rather than inventing a new gate; the defer lives in ONE line at the ingest subscription; it
reads the flag per-frame so flipping `workflow.enabled` hands ownership between the two paths with no
restart. The e2e proves it: both flags ON ⇒ exactly ONE `OcrResult` on `/screen/results`.

### Failure / ordering decisions
- **Propagation (real drain work).** `runOnDrain` throws PROPAGATE out of the executor so the queue
  re-queues the batch (retry-at-idle) and classifies the failure onto `GET /queue` — like `distill`/
  `transcribe`, unlike the best-effort `drainActs`. The drain-failure home is the QUEUE's `lastFailure`, so
  `runOnDrain` does NOT record into the processor's ingest failure ring (that ring stays the ingest path's
  health).
- **Order: OCR before the distill gate.** Screen recognition runs first and independently of
  `distill.enabled` (a frame is understood by OCR, not the transcript distiller — matching the ingest
  processor). Placing it before the distill call keeps an OCR failure's re-queue CLEAN for the flagship
  screen-only batch (distill has persisted nothing yet).
- **Known v0 limitation (documented, not fixed).** Whole-file re-queue granularity: in a MIXED batch, if a
  screen frame is recognized (persisted) and a LATER stage in the same batch throws, the retry re-recognizes
  the already-persisted frame → duplicate `OcrResult`. Same class as the deferred "DrainSample clean fix" /
  re-queue-granularity note; low-risk for the screen-only flagship case where distill has no work to fail.

### Tests + verification
`pnpm -r build && pnpm -r test` green before each commit. Engine **374** (from 364: +4 `processor.test`
drain-stage unit tests — ocr slot / vlm slot+prompt / propagating throw / blank; +5 net `executor.test`
[replaced the "no executor path yet" stub with 6 seam tests]; +1 `screen/workflow-e2e.test` — both flags ON
→ one OcrResult, the double-processing proof). Contracts **60**, client **154**, unchanged. The one
intermittent failure observed under the full run is the PRE-EXISTING `route.detect` focus-timing e2e flake
(passes 2/3 in isolation, in `route/`, untouched here) — the same drain-timing flake class PHASE4 already
records. LIVE OCR was verified end-to-end in the P4B slice-4 note (glm-ocr on LM Studio); this slice reuses
that exact recognition core (the shared `persist()`), driven from the drain instead of ingest.

### Deferred (still, out of this joint slice)
- A GET/PUT `/workflows` edit route — RESOLVED by the P4-T1 slice below (the executor's hot read seam
  needed only the HTTP surface, exactly as this note called it).
- `/screen/status` counters reflect only whichever path is the active owner; a per-path breakdown is unbuilt.
- The whole-file re-queue-granularity fix (above) and the P4B tails (Δ-gating, managed-local paddle/vlm).

## Slice: Calendar evidence — the second staged routing signal  *(P4C, branch p4c-calendar)*

Focus signals (window/repo) already drive context-switch detection; this slice adds **Calendar.app event
title + attendees as a `calendar` evidence kind** feeding the SAME detector, so a meeting can route the day
into a workspace the way a repo/window already can. Topic-drift is explicitly OUT of scope. Committed per
module: contracts → route → tests+docs.

### Contracts added (all additive)
- `CalendarSignal` (`api/payloads.ts`): `eventTitle` (required) + optional `attendees` (display names
  and/or emails), `calendarName`, `startsAt`, `endsAt`. Routing CONTEXT, never session content — the drain
  excludes it from transcripts/moments/entities exactly like a FocusSignal.
- `AttributionPattern.field` (`config/hints.ts`) gains `eventTitle` and `attendee` (append to the union).
  Field→kind extends `eventTitle`/`attendee` → `'calendar'` (`AttributionEvidence.kind` already admitted
  `'calendar'` from P3 — no session-contract change). Focus and calendar fields are DISJOINT, so a pattern
  only matches the signal type that carries its field. `attendee` matches when ANY attendee satisfies the
  matcher (the attendee list is the haystack, tested per entry).
- Example `calendarSignal.example.json` + the `route.detect` flag description now names calendar too.

### DECISION — calendar is collected ENGINE-side, fed DIRECTLY to the detector (not the chunk seam)
Focus is CLIENT-collected (electron main osascript) and carried as a `source:'focus'` CaptureChunk over
HTTP; the engine drain decodes it (`route/focus.ts`). Calendar can't mirror that seam here: this slice owns
`apps/engine/`, not `apps/client/` (a parallel effort owns the client), and calendar routing needs no
renderer/getUserMedia. So the collector lives ENGINE-side (`route/calendar-collector.ts`), samples
Calendar.app via `osascript` directly, and feeds `Attributor.observe` — the DIRECT path, no CaptureChunk.
The `calendar` `CaptureSource` stays reserved for a later chunk-transported path (documented on the
contract). This is the same "rhymes-but-differs" call the focus poller itself made vs CaptureController.

### DECISION — ONE detector buffer, ONE Attributor (the reason for the http.ts exposure)
Calendar signals must contest in the SAME sustain window as focus, not a parallel loop (two independent
loops racing to switch sessions would be a bug). So:
- `detector.ts`: the stream is now `TimedSignal` = `TimedFocusSignal | TimedCalendarSignal`; `detectSwitch`
  scores both in one window. `patternMatches` generalized to read the candidate string(s) for a field (the
  attendee list for `attendee`, else the scalar). Detector stays PURE.
- `attribute.ts`: the Attributor's rolling buffer + `observe` accept `TimedSignal`. The focus drain still
  passes focus signals (a subtype); the collector passes calendar signals — one shared buffer, one contest.
- `api/http.ts`: `attributor` is now exposed on `EngineApp` (additive) so the collector, mounted
  POST-`createEngineApp`, reaches the ONE detector buffer — exactly how `wireScreenOcr` reaches the screen
  processor. `main.ts` mounts it in ONE line (`startCalendarCollector(app, …)`), kept out of
  `createEngineApp` so the http tests never spawn an OS timer.

### DECISION — gate on the existing `route.detect` flag (no new knob)
Calendar is a SIGNAL of the same detection feature focus is, so it rides the existing master opt-in rather
than inventing a flag (the detector's `DetectorConfig` stays the only dials — the "later slices add signal
SOURCES, not knobs" note from PHASE3). The flag is read PER-TICK, so no `osascript`/Calendar access ever
runs while `route.detect` is OFF (the privacy gate). Calendar.app TCC is a separate OS-level consent; a
denied read simply yields no signals. Graceful degrade throughout: a failed/denied/empty/malformed read
yields no signals and never throws — a bad calendar poll can't wedge the loop or crash the engine.

### Module layout (`apps/engine/src/route/`)
- `calendar.ts` — PURE decode: raw collector sample (JSON events) → `TimedCalendarSignal[]`, normalizing +
  contract-checking each entry, skipping the bad ones. The client's `focus.ts` (OS reading → typed signal)
  analogue, fully unit-testable without macOS.
- `calendar-collector.ts` — the thin macOS EDGE: `CalendarPoller` (poll timer, per-tick flag gate,
  reentrancy guard, injected `sample`), the default `sampleCalendarViaOsascript` (JXA against Calendar.app
  for current/imminent events, hard timeout), and `startCalendarCollector(app, …)` (the mount, mirroring
  `wireScreenOcr`). Poll cadence 30s — several polls land inside the 90s sustain window so an ongoing
  meeting sustains presence.

### Rule-7 check (definition of done)
No route/flag surface changed (calendar reuses `route.detect` and adds no HTTP route), so no `skills/` or
CONTRIBUTING recipe goes stale. Contract additions are additive; existing hints/examples still validate.

### Tests + verification
`pnpm -r build && pnpm -r test` green before each commit. Engine **390** (from 374: +6 `calendar.test`
decode cases, +5 `calendar.test` poller-lifecycle cases, +4 `detector.test` calendar cases [title match,
attendee-only match, disjoint-field no-match, mixed focus+calendar one-window], +1 `attribute.test`
calendar-driven auto-start recording `calendar` evidence on the session). Contracts **61** (+1 CalendarSignal
example). Client **154**, unchanged. The pre-existing `route.detect` focus-timing e2e flake in
`api/http.test.ts` recurs under the full parallel run (passes 47/47 in isolation, and the full engine suite
passed 374→390 clean on re-run) — same flake class PHASE4 already records, untouched here. LIVE Calendar.app
osascript sampling is NOT exercised in CI (the OS edge is injected/stubbed in tests, per the pure/edge split).

### Deferred (queued)
- **Attendee email vs display-name matching subtleties**: v0 puts BOTH the display name and the email into
  the flat `attendees` haystack and matches a hint substring against any entry. A hint author must know
  whether to match a name or a domain; there's no structured name/email/domain distinction or organizer-vs-
  attendee weighting yet. A richer attendee model (and matching on the user's own identity to exclude self)
  is a later refinement.
- **LIVE osascript verification**: the JXA sampler is best-effort and unproven against a real Calendar.app
  with granted TCC on this rig; a manual end-to-end (grant Calendars access, join a titled meeting, watch a
  switch) should confirm the sampler shape before relying on it.
- **Chunk-transported calendar** (the reserved `source:'calendar'` path) and a client-side collector, if/when
  calendar collection should move to the client alongside focus.
## Slice: Canon + teach loop + pin ingestion  *(P4D, branch `p4d-canon`)*

The P4D slice lands the three connected pieces ARCHITECTURE §5/§10 pre-designed into `index/` + `teach/`:
earned canon (reference merging + "sent outranks viewed"), the teach-loop capture side (reroute
corrections become labeled per-workspace signals), and pin ingestion with page anchors. Everything is
additive; no route added, one gated behavior touched (the pre-seeded `ingest.gdoc` flag, seam only).

### Contracts added (all additive)
- **`TeachSignal`** (`records/teach.ts`): a labeled correction. `kind` is an OPEN, append-only union
  (`reroute` wired; `dismiss` deferred) — closed-and-append like `WorkflowStepKind`/`MomentKind`, NOT
  open-with-fallback, because a signal kind the derivation cannot interpret is a bug to surface. Carries
  `fromWorkspaceId`/`toWorkspaceId`/`sessionId`/`evidence` (the router's ORIGINAL `AttributionEvidence`
  trail, reused not forked) / `correctedAt`. No standalone `workspaceId` field — the per-workspace grain
  is the STORAGE key (keyed by `toWorkspaceId`), not a duplicated field.
- **`PinChunk`** (`records/pinChunk.ts`): one page-anchored chunk — `ordinal` (stable 0-based sequence) +
  OPTIONAL `page` (the "p. 42" anchor; absent for pageless url/plaintext, never fabricated) + `text`.
- Registered in `index.ts` (`AllSchemas` + re-exports), mapped `teachSignal`/`pinChunk`/`pin` in
  `contracts.test.ts`, examples seeded (`teachSignal.reroute.json`, `pinChunk.pdf.json`, `pin.pdf.json` —
  the previously-exampleless `Pin` now has one). Schemas regenerated (+3: PinChunk, TeachSignal,
  TeachSignalKind). Contracts test 60 → 63.

### DECISION — earned canon merges at READ time; the persist-the-merge write side is deferred
The store's `upsertEntity` already merges at WRITE time by exact (kind, normalized-name-or-alias). What
escapes it is the residue `mergeCanon` catches: two records sharing an ALIAS but written under different
canonical names, or records mergeable only after aliases accrued. `relevant.ts` folds the workspace's
entities through `mergeCanon` BEFORE ranking, so a person written twice surfaces as ONE canonical row
(evidence unioned). This is a READ-time fold — pure, deterministic (union-find + total-ordered winner,
input-order-independent), and reversible by simply not folding — rather than a write-time migration. A
`store.mergeEntities(canonicalId, mergedIds)` that persists `canonicalOf` and remaps `Moment.refs` is the
write side, DEFERRED until a surface needs persisted canon (no public store merge exists today —
`mergeEntity` is private to `upsertEntity`).

### DECISION — "sent outranks viewed" is a rank MULTIPLIER, unchanged at outboundCount 0 (honest v0)
`rank.ts`'s formula gains `× (1 + outboundBoost·log2(1 + outboundCount))`, log-damped exactly like
frequency (a 40×-sent artifact cannot dwarf everything). Shaped so `outboundCount === 0` yields multiplier
1.0 — the score is byte-identical to the pre-canon formula, which is why every prior `rank.test.ts` case
(all outboundCount 0) stays green. One send at `outboundBoost 1` doubles the score, so a sent version
outranks an equally-frequent merely-viewed one (the design requirement). **Honest v0 note (not faked):**
NO code path increments `Entity.outboundCount` — the Act pass prepares drafts that are never sent
(`act/draft.ts`), so there is no honest "sent" event to count yet. The READ side is wired; the write side
(a future outbound-mail/commit watcher or a "mark sent" action → a one-line store increment) is the
documented deferred seam. Faking a source now would lie about which versions were actually sent.

### DECISION — teach signals are store-backed documents keyed by the CORRECTED-TO workspace
`TeachStore` mirrors `HintsDocuments`/`TodoDocuments`: a versioned document (`store.layouts`, kind
`teach-signals`) keyed by `toWorkspaceId` — the workspace that should LEARN to claim these signals (its
hint patterns are what the derivation suggests). `record()` is IDEMPOTENT by a session-deterministic
signal id (`teach-reroute-${sessionId}`), so a replayed `session.rerouted` (or a re-reroute) replaces
rather than double-counts. `teach/` never opens a DB (dep rule 2 — asks `store.layouts`). `wireTeach(app)`
subscribes `session.rerouted` and records, mirroring `wireScreenOcr` (one line in `main.ts`, keeping bus
wiring out of the P4A-owned `api/http.ts`). The derivation `deriveHintCandidates` is a PURE read →
SUGGESTED `AttributionPattern` candidates (window/repo evidence → windowTitle/repoPath patterns,
aggregated by support across reroutes); it is **never written into `route/hints` documents and never
edits `route/`** — the loop SUGGESTS, the user APPLIES. calendar/voice evidence (not focus fields) and the
`manual` reroute marker are excluded from candidates — a suggestion the detector can't honor is not made.

### DECISION — PDF ingestion is an HONEST STUB (option b), not a new dependency
The engine's dependency policy is deliberately minimal (`better-sqlite3` + `typebox` only). Weighed:
- (a) add ONE small PDF parser dep — but `pdf.js`/`pdf-parse` pull a LARGE transitive tree, a real policy
  change that deserves explicit owner sign-off, not a slice-author's unilateral add; and
- (b) **land the full ingest seam + page-anchor chunking, with `pdf.ts` a documented honest stub** — chosen.
The NOVEL part (page-anchored chunking — "how an answer cites p. 42") is fully built and tested against
multi-page fetched docs; the `file` fetcher (form-feed `\f` = real plaintext page anchors) and `url`
fetcher (pageless) exercise the entire lifecycle honestly. `pdf.ts` throws a clear, actionable error → the
pin records `ingest.status: 'failed'`, NEVER fabricated pages. Hand-rolling a binary PDF parser was never
on the table. The moment a vetted parser is approved it is the ONE file that changes. `gdoc` is a seam-only
stub behind the seeded `ingest.gdoc` flag (added to the fetcher registry only when the flag is on; the OAuth
flow is out of scope).

### Module layout
- `index/canon.ts` (pure) — `mergeCanon`; `index/rank.ts` — the canon weight in `scoreEntity`;
  `index/relevant.ts` — folds through `mergeCanon` before ranking.
- `teach/signals.ts` — `TeachStore` + `captureReroute` + `deriveHintCandidates`; `teach/index.ts` —
  `wireTeach` + barrel.
- `index/ingest/` — `chunk.ts` (pure page-anchored chunking, deterministic `${pinId}-${ordinal}` ids for
  idempotent re-ingest), `fetcher.ts` (`PinFetcher` + file/url/pdf-stub/gdoc-seam + `defaultFetchers`),
  `ingest.ts` (the lifecycle → store), `index.ts` (barrel).
- `store/workspaces.ts` — `pins` + `pin_chunks` tables (per-workspace DB, since a pin is workspace-level
  canon like an entity, NOT session-keyed → `moveSession` untouched) + `savePin`/`getPin`/`listPins` +
  `savePinChunks`/`listPinChunks`/`deletePinChunks`, contract-validated (dep rule 2). One line in `main.ts`.

### Deviation from the plan (with rationale)
The plan batched all tests into a final slice 5; instead tests are COLOCATED WITH each module's commit
(`canon.test.ts`, `rank.test.ts` additions, `signals.test.ts`, `chunk.test.ts`, `ingest.test.ts`, the store
pin test), so every commit is independently green AND verified. Slice 5 is therefore docs only. This is
the repo's own colocated-`node --test` convention and matches "each module ships green."

### Rule-7 check (definition of done)
- **Route:** NONE added — teach capture is a bus subscription (no HTTP surface), and pin CRUD / a
  `/pins` route + a teach-candidates read route are deliberately deferred (the "API is the slice"
  discipline — the read seams `TeachStore.list`/`deriveHintCandidates`/`store.listPins` are ready for a
  later route with no logic change). So CONTRIBUTING rule 7's "changed a route surface" clause is
  **satisfied vacuously**.
- **Flag:** no NEW flag. `ingest.gdoc` already exists (seeded); this slice only reads it as the seam gate
  for the gdoc fetcher — a pre-existing gated behavior, not a new one.
- **Recipes/skills:** grepped `skills/` + `CONTRIBUTING.md` for `canon|teach|reroute|pin|ingest|outbound`.
  No recipe or skill references any of these surfaces (the shipped `add-a-block` skill enumerates only the
  flags/routes ITS block-source recipe touches). Nothing to keep true.
- **Contracts:** additive only (two records + examples + regenerated schemas; existing examples still
  validate). **CODE_MAP:** `index/` and `teach/` tree rows updated to BUILT; a new §3 "Canon + teach loop
  + pin ingestion" row + the gdoc row reconciled.

### Tests + verification
`pnpm -r build && pnpm -r test` green before each commit. Final totals: contracts **63** (+3 examples),
engine **401** (from 374: +8 canon/rank in `index/`, +6 `teach/signals.test`, +12 `ingest`
[chunk 6 + ingest 6], +1 store pin test), client **154**. The ONLY failure seen under the full parallel run
is the documented `route.detect ON` teardown flake (`ENOTEMPTY` on the temp-queue rmdir, in `route/` which
this slice does not touch) — confirmed passing 3/3 in isolation; on the clean per-slice runs all three
suites were fully green. **LIVE check** (real compiled `dist`, real sqlite `WorkspaceRegistry` + `EventBus`,
no HTTP since no route was added): published a `session.rerouted` → one `TeachSignal` captured + a
`repoPath` hint candidate derived; ingested a real form-feed file → status `ingested`, pages 2, chunks
anchored `p.1 p.2`; a `pdf` pin → status `failed` with the honest error; two "Dana"/"Dana Cruz" forms →
`mergeCanon` folded to ONE entity (aliases unioned, mentions summed to 2), relevant-now returned one
deduped row.

### Deferred (out of this slice, by scope)
- **`outboundCount` write side** — nothing increments it yet (drafts are prepared-never-sent); a future
  send event (outbound-mail/commit watcher or a "mark sent" action) feeds ranking with a one-line store
  increment and no rank-formula change.
- **`dismiss`-kind teach signals** — the union has room; deferred until a dismiss ("not a commitment" /
  "not this entity") surface exists to emit it.
- **Feeding derived candidates back into extraction prompts / a teach surface** — `deriveHintCandidates`
  is the consumable output; wiring it into a prompt or a review UI (and an apply action) is the next step.
- **Persisted canon** — a `store.mergeEntities` that writes `canonicalOf` + remaps `Moment.refs` (the fold
  is read-time only today).
- **A PDF parser dependency** (owner sign-off) and **gdoc OAuth** (beyond the flag-gated seam).
- **`/pins` CRUD + a teach-candidates read route** — RESOLVED by the P4-T2 slice below (GET/POST
  `/pins`, POST `/pins/:id/ingest`, GET `/pins/:id/chunks`, GET `/teach/candidates` — over the exact
  read seams this note called ready, NO logic change, as predicted).

## Slice: GET/PUT `/workflows` — the pipeline is user-composable over the API  *(P4-T1, branch p4t1-workflows)*

The executor (Executor v0 slice) already reads the workflow document FRESH per drain / session-end
(`WorkflowDocuments.active()`), so a stored edit takes effect with no restart — the only thing missing
was the HTTP surface. This slice lands it: `GET /workflows` (list), `GET /workflows/:id` (one, 404
unknown), `PUT /workflows/:id` (validated, version-bumped edit). The pipeline itself is now editable over
the API — the highest-leverage single route in the P4 tail. **ZERO executor change**, as both earlier
deferral notes predicted. Committed per module: contracts → engine → tests → docs.

### Contracts added (all additive)
- Three `Routes` rows in `api/routes.ts` (phase 4): `GET /workflows` → `WorkflowSpec[]`, `GET
  /workflows/:id` → `WorkflowSpec`, `PUT /workflows/:id` (request+response `WorkflowSpec`). No new schema
  — `WorkflowSpec` already exists (P4A slice 1); no example file (the seeded `workflow.default.json`
  already validates in `contracts.test`). Mirrors the `/todos` + `/layouts/surfaces` rows exactly.

### DECISION — `WorkflowDocuments.save` is version-stamped + contract-validated (the Tier-A gate)
Added an additive `save()` (and `list()`) mirroring `TodoDocuments.save` / `SurfaceDocuments.save`: it
stamps `version` = latest stored + 1 (a caller-supplied/forged version never wins — the store is the
monotonic source of truth, and every prior version is kept), and it `Value.Check`s the body against
`WorkflowSpec` BEFORE write. This is the last line of defense: because `WorkflowStepKind` is a CLOSED
union (a step *does work* and has no safe execution fallback, unlike a block that just renders), a step
naming an unrunnable primitive (`foo`/`teleport`) is rejected at write time rather than reaching the
executor as a silent no-op. A rejected write throws; the PUT route maps that to a 400 via the same
`validationErrors('WorkflowSpec', body)` guard that runs first, so a bad kind is caught before `save`.

### DECISION — PUT-unknown-id CREATES (does not 404), mirroring PUT /todos
`PUT /workflows/:id` with an unknown id creates a new workflow document (version 1), it does NOT 404 —
identical to `PUT /todos/:id` (which creates a session's list on first write) and `PUT
/layouts/surfaces/:id`. Only `workflow-default` exists today, and the executor's `active()` is pinned to
that id, so a newly-authored named workflow is inert until a future "which workflow is active" selector
wires it in — creating it here is a harmless, forward-compatible document write. Refusing it would make
the resource write-once for the default alone, out of step with every other document route. The body's
`id` must still match the route (a mismatch is a 400, mirroring the `/todos` sessionId-matches-route
policy). GET, by contrast, DOES 404 an unknown id (mirroring `GET /todos/:id` / `GET
/layouts/surfaces/:id`) — you can only read what exists (or the seeded/code-fallback default).

### Rule-7 check (CONTRIBUTING)
Additive routes only — nothing removed, so no consumer goes stale. `skills/add-a-block/SKILL.md` is the
only skill referencing `routes.ts`, and it is scoped to surface/block edits (`/layouts/surfaces`), which
this slice does not touch. No skill or recipe references `/workflows` or the workflow document. Nothing to
keep true.

### Tests + verification
`pnpm -r build && pnpm -r test` green before each commit. Final totals: contracts **64** (unchanged — no
new example), engine **424** (from 417: +5 `workflow/documents.test` [list has the seed; save bumps +
keeps history + ignores a forged version; the Tier-A reject; the create-new-id path], +2 `api/http.test`
[the 4-in-1 route test: list/404/400-bad-body/400-bad-kind/400-id-mismatch/valid-bump; and the hot-edit
e2e]), client **154** (untouched). The ONLY failures under the full parallel run are the two PRE-EXISTING
documented flakes — `route.detect ON` teardown `ENOTEMPTY` (in `route/`, untouched) and the client
engine-link seam TOCTOU (in `apps/client/`, untouched) — both confirmed passing in isolation.
**HOT-EDIT e2e (the "user composes the pipeline" proof)**: with `workflow.enabled` + `distill.enabled` +
`distill.moments` + `distill.index` all ON, PUT an edited `workflow-default` that DROPS the `moments`
step (its `when.flag` stays ON), then capture a batch. Entities hydrate (distill+index ran → the pipeline
is live under the edited doc) but the session's moments stay EMPTY — the removed step took effect on the
very next drain with NO restart. If the executor read the flag rather than the document, moments would
still have been extracted; it reads the document, so the edit wins.

### Deferred (out of this slice, by scope)
- **A `DELETE /workflows/:id`** — no delete story yet (the default must not be deletable; a named-workflow
  delete waits on the selector below). Additive when a use case lands.
- **An "active workflow" selector** — `active()` is pinned to `workflow-default`, so a PUT to a NEW id
  authors an inert document. A `workflow.activeId`-style pointer (config doc or flag) makes authored
  workflows selectable; deferred until there is more than one workflow to choose between.
- **A `workflow.changed` WS broadcast** — surfaces/fabric publish on save so a live client hot-reloads;
  a workflow edit does not (the executor re-reads per drain regardless, so no restart is needed — the WS
  push would only be for a future workflow-EDITOR UI to reflect a concurrent edit). Additive, like
  `surface.updated`.

## Slice: `/pins` + `/teach` read/write surfaces — corrections + pinned canon become inspectable chips  *(P4-T2, branch p4t2-pins-teach)*

P4D shipped the pin-ingestion lifecycle (`index/ingest/`), the pinned-canon store methods, and the teach
loop's capture + pure derivation — but every one of those was reachable only in-process. This slice lands
the HTTP surface, so a correction and a pinned document become inspectable, citable chips a surface can
render. **ZERO logic change to `index/ingest` or `teach/`**, exactly as the P4D rule-7 note called it: the
store reads (`listPins`/`getPin`/`listPinChunks`), the ingest orchestrator (`ingestPin`), and the pure
`deriveHintCandidates` over `TeachStore.list` all already existed; only the routes were missing. Committed
per module: contracts → engine → tests → docs.

### Routes built (all over existing seams)
- `GET /pins?workspace=` — a workspace's pins (workspace-level canon, `?workspace=` default `default`;
  unknown workspace → `[]`, mirroring `GET /entities`).
- `POST /pins` — create a pin (validate body as `Pin` → `store.savePin`; 400 on a bad body). A created pin
  carries `ingest.status: 'pending'` until ingest resolves it.
- `POST /pins/:id/ingest?workspace=` — run `ingestPin` (fetch → page-anchored chunk → persist
  `pin_chunks` + a terminal `ingest.status`). Unknown pin → 404.
- `GET /pins/:id/chunks?workspace=` — the page-anchored excerpts in ordinal order (the "cite p. 42" read).
  Unknown pin → 404; a not-yet-ingested pin → `[]`.
- `GET /teach/candidates?workspace=` — `deriveHintCandidates` over `TeachStore.list` for the workspace.

### Contracts added (all additive)
- Three `Routes` rows in `api/routes.ts`: `POST /pins/:id/ingest` → `Pin`, `GET /pins/:id/chunks` →
  `PinChunk[]`, `GET /teach/candidates` → `HintCandidate[]` (GET/POST `/pins` were already declared, phase
  3, unimplemented until now).
- New `HintCandidate` payload (`api/payloads.ts`, mirroring `RelevantEntity` — a derived/join type): the
  SUGGESTED attribution-hint pattern the derivation emits (`workspaceId` + `AttributionPattern` +
  `supportCount` + traceable `sampleSessionIds`). The engine's `teach/signals.ts` `HintCandidate` interface
  is structurally identical, so the route serves it with no engine change and no duplication of intent.
- `schema-gen` (`pnpm contracts:gen`) regenerated `shared/contracts/schemas/`: adds `HintCandidate.json`,
  and incidentally brought `AttributionPattern.json` / `WorkspaceHints.json` / `CalendarSignal.json` back in
  sync with source — pre-existing drift a prior P4C calendar-evidence merge left un-regenerated (the
  `eventTitle`/`attendee` fields and the `CalendarSignal` schema had never been emitted).

### DECISION — pins are workspace-scoped via `?workspace=` (not a cross-workspace id lookup)
A pin is a WORKSPACE-level record (like an entity, not session-keyed — it lives in the workspace's own
sqlite file and is NOT moved by `moveSession`). The store's read methods are all keyed by workspace
(`getPin(workspaceId, id)`, `listPinChunks(workspaceId, pinId)`), so the routes take `?workspace=` (default
`default`) — the exact convention `/moments`, `/entities`, `/drafts`, `/relevant` already use. No
cross-workspace `findPin` was added: it would duplicate the keying the store already enforces, and a pin id
is only meaningful within its workspace. (This differs from `/sessions/:id` — sessions ARE globally unique
by design; pins are not.)

### DECISION — an ingest failure is a 200 whose `ingest.status` tells the truth (not a 5xx)
`ingestPin` NEVER throws on a fetch failure — it catches the fetcher's throw and records
`ingest.status: 'failed'` with the message, writing no chunks (it never leaves a half-state and never
fabricates pages). So `POST /pins/:id/ingest` returns **200** with the resolved pin whose `ingest` states
the outcome verbatim: `ingested` (pages + chunk count) OR `failed` (the fetcher's error). The only 404 is an
unknown pin id. This surfaces exactly what the module reports — the pdf HONEST STUB comes back
`failed` with "PDF text extraction is not wired…" and gdoc (behind the `ingest.gdoc` flag seam, read
per-call) with its auth message — rather than dressing a known-unsupported path as an HTTP error or a fake
success. A transport/HTTP-layer failure (bad JSON, etc.) is still the normal 500/400; the ingest OUTCOME is
document state, not an HTTP status.

### DECISION — `/teach/candidates` is read-only and never applies a candidate (P4-T3b owns apply)
The handler constructs a stateless `TeachStore` over `store/`, reads the workspace's signals, and returns
`deriveHintCandidates` — a PURE fold. It writes nothing, and in particular never touches a workspace's
`WorkspaceHints` document (a test asserts the hints doc stays absent after the read). Candidates are
SUGGESTIONS a human reviews; auto-applying them to `route/hints` is a separate future slice. Signals are
captured by `wireTeach` (a bus subscription on `session.rerouted`, wired in `main.ts` — not by this route);
a bare `createEngineApp` has no teach wiring, so the route reads whatever signals exist (empty → `[]`).

### Rule-7 check (CONTRIBUTING)
Additive routes only — nothing removed, so no consumer goes stale. `skills/add-a-block/SKILL.md` is the
only skill referencing `routes.ts`, scoped to surface/block edits; neither it nor the CONTRIBUTING recipes
reference `/pins`, `/teach`, ingest, or the pin/teach documents (`skills/README.md` lists a "pin-and-ingest"
skill only as PLANNED/not-yet-written). No rail to keep true.

### Tests + verification
`pnpm -r build && pnpm -r test` green before each commit. Final totals: contracts **64** (unchanged — no
new example; `HintCandidate` needs none), engine **427** (from 424: +3 in `api/http.test` — the pins
create→ingest→chunks e2e over a FILE fixture, the pdf honest-stub failure surfacing, and the teach-candidate
derivation), client **154** (untouched). **Pins e2e (the "cite p. 42" proof):** POST a pending `file` pin
whose uri is a temp two-page (form-feed) fixture → POST ingest → the pin resolves to `ingested` with
`pages: 2` → GET chunks returns two excerpts anchored to pages `[1, 2]`, each carrying its page's prose (no
network — the file fetcher over a temp fixture). **Teach flow:** two reroutes corrected to `sales` with the
same repo evidence derive ONE aggregated candidate (`repoPath` / `~/code/acme`, `supportCount: 2`, strongest
weight `0.9`, both session ids), scoped per workspace, with the hints document left untouched.

### Deferred (out of this slice, by scope)
- **`PUT/DELETE /pins/:id`** — edit/forget a pin. Create + ingest + read is the P4-T2 charter; a mutable pin
  document (retitle, re-point uri) and a delete (drop pin + its chunks) are additive when a surface needs
  them.
- **Applying a hint candidate** (`POST` to add the pattern to a workspace's `WorkspaceHints`) — P4-T3b; this
  slice is the inspectable READ only, keeping "the loop suggests, the user applies."
- **A real PDF parser + gdoc OAuth** — unchanged from P4D: the ingest route faithfully surfaces both as
  honest failures until the vetted parser / auth flow lands.
- **Pins/candidates as rendered HUD blocks** — the block `source` for pins is still unbuilt (renders
  empty-but-explainable, per `skills/add-a-block`); wiring a `BlockQuery.source` for pins/teach-candidates so
  a surface renders the chips is a surfaces slice, not this API slice.

## Slice: GET/PUT `/hints` — apply-with-review closes the teach flywheel  *(P4-T3b, branch p4t3b-hints, on main)*

P4-T2 landed `GET /teach/candidates` (read-only: a correction SUGGESTS a pattern) and explicitly deferred
"applying a hint candidate" to P4-T3b. This slice lands the APPLY half: the HTTP edit surface for a
workspace's `WorkspaceHints` document. "Apply a candidate" is NOT a special auto-apply verb — it is just the
client PUTting an updated hints doc that includes the reviewed candidate's pattern. **ZERO logic change to
`route/`**: the `HintsDocuments` store class (`all`/`get`/`put`) already existed (its own comment called an
HTTP editing route "a later slice" — this is that slice; the comment was updated). Committed per module:
contracts → engine → tests → docs.

### Routes built (all over the existing `HintsDocuments` seam)
- `GET /hints` — every workspace's latest hints document (`hintsDocs.all()`). This is the exact view the
  detector scores signals against (route/detector.ts), so it is the whole-fabric read a review surface reads.
- `GET /hints/:workspaceId` — one workspace's hints document. Unknown workspace → 404 (only `default` is
  seeded with an empty doc; any other workspace has none until a user PUTs one — nothing to serve).
- `PUT /hints/:workspaceId` — persist an edited hints document (validate body as `WorkspaceHints` → 400 on a
  bad body, 400 on a body whose `workspaceId` ≠ the route; store version-stamps + preserves history). The
  detector reads `hintsDocs.all()` fresh per window, so an applied pattern takes effect with NO restart.

### Contracts added (all additive)
- Three `Routes` rows in `api/routes.ts`: `GET /hints` → `WorkspaceHints[]`, `GET /hints/:workspaceId` →
  `WorkspaceHints`, `PUT /hints/:workspaceId` request `WorkspaceHints` response `WorkspaceHints` (phase 4).
  `WorkspaceHints`/`AttributionPattern` were already exported contracts (P3, `config/hints.ts`) — no new
  schema, so `schema-gen` and the contracts example count are unchanged.

### DECISION — PUT does NOT gate on the workspace record existing (mirrors PUT /workflows, createPin)
An unknown `workspaceId` on PUT CREATES the workspace's hints doc (version 1); it is NOT a 404. This is the
same policy `PUT /workflows/:id` uses (an unknown id creates version 1, it does not 404) and consistent with
`createPin` (persists without a workspace-existence check). No other document write invents a
workspace-existence precondition, and doing so here would be out of step; an empty `patterns` array simply
matches nothing, so a hints doc for a not-yet-populated workspace is harmless. GET-by-id still 404s, because
there is genuinely no document to serve until a PUT creates one (the seeded `default` is the one exception).

### DECISION — no auto-apply; "apply a candidate" is a plain document edit
The route adds no derivation and touches no `route/` logic. `/teach/candidates` suggests; the user reviews;
the client PUTs a hints doc containing the chosen pattern. Keeping apply as an ordinary versioned-document
write (not a `POST /teach/candidates/:id/apply`-style verb) means the same route edits, reorders, tunes
weights, or removes a pattern — the whole hints doc is user-composable, exactly like every other config
document — and the human stays in the loop (the loop suggests, the user applies).

### Tests + verification
`pnpm -r build && pnpm -r test` green before each commit. Final totals: contracts **64** (unchanged — no new
schema), engine **429** (from 427: +2 in `api/http.test`), client **154** (untouched). The two new tests:
(1) **routes** — the seeded default lists + resolves, GET-by-id 404s an unknown workspace, PUT rejects a
garbage body (400) and an id/route mismatch (400), a valid PUT creates + reads back and a second edit
version-bumps in the store. (2) **flywheel e2e** — seed two reroutes to `sales` (the real `TeachStore`
capture path) → a matching focus stream detects NOTHING first (`detectSwitch` over `GET /hints` = the seeded
empty default → `stay`) → `GET /teach/candidates` yields the candidate → PUT it into `sales` hints → `GET
/hints` reflects the applied pattern → the SAME focus stream now `switch`es to `sales` with the repo hint as
evidence. This drives the detector over the exact hint provider the attributor uses (`hintsDocs.all()`),
proving the correction the user made once is generalized: teach → suggest → apply → attribute.

### Deferred (out of this slice, by scope)
- **`DELETE /hints/:workspaceId`** — forget a workspace's hints entirely. Editing to `patterns: []` already
  neutralizes a workspace's detection; a hard delete of the versioned document is additive when a surface
  needs it (mirrors the deferred `DELETE /pins/:id`).
- **A `/teach` review surface (rendered HUD block)** — the block `source` that renders candidate chips beside
  the workspace's live hints, with an in-UI "apply this pattern" that PUTs the merged doc, is a surfaces
  slice over these routes, not this API slice (same posture as the deferred pins/candidates blocks above).
- **Dismiss-kind teach signals feeding candidate suppression** — still the P4D-deferred item; applying a
  candidate here does not mark it applied, so it keeps appearing in `/teach/candidates` until dismiss lands.

## Slice: three fabric/test-probe fixes from wiring a real omlx endpoint  *(on main)*

Wiring a real local endpoint end-to-end (omlx serving `LFM2.5-8B-A1B-MLX-8bit` on `0.0.0.0:8000`, an
`http`/`openai-compat` endpoint with `auth.keyRef`, stored via `PUT /fabric` + `PUT /fabric/secrets/:ref`)
surfaced three places where the health/test path disagreed with how real servers behave. Real INVOCATIONS
worked throughout — `invokeLlm` returned clean completions — but the settings **Test** button was
structurally red for the whole omlx/reasoning-model class. Committed per module: fabric health → fabric
invoke → api probe → docs.

### Fix 1 — health ping falls back to `GET /v1/models` for openai-compat (`fabric/health.ts`)
The ping GETs the endpoint's bare base url. FastAPI-style servers (omlx) serve no root route — `GET /` is
404 while `/v1` answers fine — so a perfectly healthy server pinged `HTTP 404` forever. Root is still tried
first; only an `openai-compat` endpoint whose root fails gets the dialect's own listing route as a second
opinion. Root-answering servers and non-/v1 dialects (whisper.cpp, paddle) are untouched.

### Fix 2 — a MISSING `message.content` with reasoning tells is reasoning-exhausted (`fabric/invoke.ts`)
Some servers OMIT the `content` field entirely — instead of sending `''` — when every generated token went
to reasoning (omlx does this for an LFM2.5/qwen3.5-class model at a small `max_tokens`). The missing-string
check threw `bad-response` BEFORE the reasoning-exhausted classifier could see the tells
(`reasoning_content` / `finish_reason: length`), flattening an actionable state into "garbled response".
Same exhaustion, different wire shape; it now classifies the same. Missing content WITHOUT the tells stays
`bad-response`.

### Fix 3 — the generate probe counts reasoning-exhausted as generation ✓ (`api/http.ts`)
The probe's REAL 1-token completion is exactly the budget a reasoning model spends thinking, so the Test
button could never pass for one (the invoke.ts comment already documented qwen3.5-9b failing this way on
LM Studio). But the probe exists to catch a server that pings 200 yet can't load its model — and a
reasoning-exhausted failure means the model LOADED and GENERATED through the real invoke path. That is the
probe's proof, so it reports `ok: true` with a note saying where the budget went. Real invocations run with
a real token budget and keep the classified failure (raise the budget / pick an instruct model stays a real,
surfaced state).

### Tests + verification
`pnpm -r build && pnpm -r test` green before each commit; each fix landed with a regression test that fails
without it. Final totals: contracts **64** (unchanged), engine **432** (from 429: +1 `fabric/health.test`,
+1 `fabric/invoke-error.test`, +1 `api/http.test`), client **154** (untouched). Verified live against the
running engine: `POST /fabric/test` with `probe:'generate'` on the omlx endpoint reports
`ok: true · generation ✓` (previously `HTTP 404 · generation ✗ bad-response`), and `invokeLlm` over the
STORED fabric + secret returns a clean completion from `dev-mac-omlx`.

### Deferred (out of this slice, by scope)
- **A managed `mlx` runtime spec** — `RUNTIME_SPECS` still has only llama.cpp/whisper.cpp, so a
  `kind:'local', runtime:'mlx'` endpoint falls through (gracefully). omlx is its own server; the `http`
  kind covers it. A spec entry is additive when engine-owned mlx lifecycle is wanted (CONTRIBUTING recipe).
- **Probe wording in the setup surface** — the browser script already renders `generate.note`-less ✓ rows;
  showing the note ("budget went to thinking") beside the ✓ is a surfaces touch, not this fix.

### Addendum — generate-probe timeout raised 8s → 30s (`api/http.ts`)
A cold 12B load (~6.3s) plus the 1-token completion exceeded the old 8s generate-probe budget, so the first
Test press on a cold model timed out. Raised to 30s; the reachability ping (`checkEndpoint`, 4s) stays
snappy since it only proves the socket answers, not that a model loaded.

## Slice: rig-truth fabric defaults + managed omlx  *(P4-T8, on main)*

Owner directive 2026-07-09: "support modern tooling like omlx… stop hardcoding lm studio or llama3-8b.
Depend on what I really have." The fabric was describing a rig nobody has — seeded templates named a
fictional `local-model` on LM Studio :1234 and `llama3.2:3b` on ollama :11434, while the real rig runs
omlx (:8000, bearer-gated) serving MLX models, LM Studio (:1234, no auth), and an empty ollama. Two
halves, committed separately; the discovery/scan machinery already existed (`fabric/discover.ts`,
`fabric/scan.ts`) so this built on it rather than forking a parallel scanner.

### (a) Discovery tells the truth — kill the fictions, surface omlx's 401 (`fabric/{defaults,discover,discovery-defaults}.ts`)
The offered configs must not name a model or port a scan didn't actually see, so the truthful source is
DISCOVERY (`GET /fabric/discover`) and the host SCAN (`POST /fabric/scan`), not a hardcoded list.
- **`defaults.ts`**: deleted `lm-studio-local` and `ollama-local` (the fictional-model templates). The one
  remaining seeded profile is the sanctioned exception — an explicit blank MANUAL scaffold for a host a
  localhost scan can't reach (remote/LAN/authed), naming no model or port a scan hasn't confirmed. Two
  `shared/contracts/examples/fabricProfile.*.json` deleted to match; `remote-http-template` demoted.
- **`discover.ts`**: the gap the directive named — the probe sent no auth, so omlx's `401` on
  `/v1/models` read as a silent miss. A `401/403` is now a DISCOVERY RESULT: `reachable:true,
  authRequired:true` (the server ANSWERED, it just wants a key). When a probe names a `keyRef` AND that
  secret is stored, discovery RETRIES with the bearer and enumerates the models; with no key it still
  surfaces present-but-needs-a-key. Probe I/O (`fetchModels`) is split from pure classification
  (`modelsFromBody`); value-free — only the ref is ever named. `DiscoveryProbe` gained optional `keyRef`,
  `DiscoverServer` optional `authRequired` (both additive). The resolver is wired through the
  `/fabric/discover` route and the Get-Started render path.
- **`discovery-defaults.ts`** + probe-list example: added `omlx` (:8000, `keyRef:'api_d'`); dropped the
  never-present `speaches` entry (omlx now owns :8000). The seeded capability map already classifies the
  whole real rig correctly (parakeet→stt, kokoro/`*tts*`→tts, `*embed*`→embed, the rest→llm) — no change.

### (b) omlx as a managed `mlx` runtime — adopt-not-collide (`fabric/endpoints/local.ts`, `invoke.ts`, `health.ts`)
Absorbs P4-T7's mlx intent. A `kind:'local', runtime:'mlx'` endpoint now RESOLVES instead of throwing
"local runtime not managed".
- **`RUNTIME_SPECS.mlx`**: binary `omlx`, OpenAI-compat chat on a FIXED port (:8000), `/health`.
  `multiModel` (one server backs llm/stt/tts from a model dir — `endpoint.model` selects per request, no
  single `-m` file) + `adoptOnly`.
- **Discover-and-adopt, never spawn-and-collide**: omlx is supervised OUTSIDE the engine (oMLX.app + the
  `com.openinfo.omlx` LaunchAgent), so `ensureRunning` ADOPTS a server already answering on its port
  (recorded WITHOUT a child, so `shutdown` never kills the supervisor's process) or fails honestly
  ("not running on :8000 — start it via oMLX.app"). A multi-model runtime is keyed by port, so every slot
  shares the one adopted process. The precedent (llama.cpp spawns on a FREE port, never colliding) is
  followed and improved: omlx's fixed port is adopted, not raced.
- **Auth on the local kind**: the `Endpoint` `local` variant gained the same optional `keyRef` auth the
  `http` variant has (additive) — omlx needs a bearer even on localhost. `resolveLocal` carries it onto
  the synthetic http endpoint so invoke injects the bearer; `checkEndpoint` LIVE-probes an adopt-only
  runtime's port with the same keyRef→bearer (`status()` can't know an external process's liveness
  synchronously — a live probe is the honest signal, exactly as an http endpoint is probed).

### Templates-route shape decision
No shape change and NO `apps/client` edits. The settings UI is engine-served (`surfaces/setup/view.ts`
composed by `api/http.ts`); it reads `GET /fabric/profiles` and the discovery/scan results whose contracts
grew only ADDITIVELY (`authRequired`, probe `keyRef`, local `auth`). Existing response shapes stay valid,
so the client — which is a pure HTTP/WS client and does not read profiles/templates directly — was not
touched.

### Tests + live verification
`pnpm -r build && pnpm -r test` green before each commit. Contracts **64 → 62** (two fictional example
files removed), engine **432 → 440** (+3 discover-401 cases: no-key needs-auth, stored-key retry
enumerates, wrong-key refusal; +5 mlx: spec shape, adopt/multi-model/absent-port, keyRef→bearer carry
through invoke+health), client **154** (untouched). One pre-existing FLAKY engine test intermittently
probes a real localhost port on this live rig (baseline flaked too) — two clean full runs confirmed 440/0.

Verified LIVE against the real rig (compiled dist against the running servers):
- Discovery with NO key → omlx `authRequired`, models=0, `needs a key (keyRef "api_d" not stored yet)`;
  LM Studio enumerates 36 real models; ollama present-but-empty; kokoro/whisper absent.
- Discovery WITH `api_d` resolved → omlx retry enumerates **32** real models; the config-1 suggestion fills
  stt (`…parakeet-tdt_ctc-110m`), tts (`…Kokoro-82M-bf16`), and embed from real ids — one omlx, three slots.
- Managed omlx adopt: `ensureRunning` adopts the running server (no spawn, no binary/model file needed),
  authed health `ok:true` (2ms) / honest `unresolved secret keyRef "api_d"` without, a real completion
  through the bearer, and omlx still up after `shutdown` (the engine never owned it).

The engine on :8787 serves stale dist from memory (not restarted); staleness noted, not touched.

### Deferred (out of this slice, by scope)
- **Managed-local `paddle`/`vlm` runtime** — the remainder of the old P4-T7. Not trivial after mlx: a
  different serving dialect (`paddle-serving`) and a single-model-file spawn story, unlike omlx's adopt.
  Stays queued.
- **`generate` probe + Test button over a local mlx endpoint** — the Test path targets `http`/`cloud`
  today; pointing it at a `kind:'local'` omlx endpoint (adopt then probe) is a small `api/http.ts`
  follow-up, not required for invoke/health which already carry it.
- **ollama's `/api/tags`** — ollama serves OpenAI-compat `/v1/models` (present-but-empty on this rig via
  the existing path), so the native tags route was not needed; a fallback is additive if wanted.

## Slice: release 0.0.1 — an installable DMG that runs the pipeline on first launch  *(on main)*

The client was a pure HTTP/WS client to an engine URL; a double-clicked .app had nothing to talk to (the
feasibility research in `docs/local/packaging-and-first-run.md` named this the fatal gap). 0.0.1 closes it:
the app now **ships the engine** and **spawns it on first launch** unless one already answers — an installable
arm64 DMG that isn't a dead shell.

### Engine-spawn seam (`apps/client/src/main/engine-supervisor.ts` + `shell.ts`)
- **Decision is PURE + headless-tested; shell.ts holds only the electron edge.** `decideEngineDisposition`:
  reachable ⇒ `adopt` (spawn nothing), unreachable + bundled ⇒ `spawn`, unreachable + no bundle ⇒
  `unreachable`. `checkEngineReachable` is a `GET /health` under an AbortController timeout (any error/non-ok
  ⇒ false); `waitForEngine` polls it after a spawn over an injected sleeper (deterministic in tests).
  `bundledEngineEntry`/`portFromEngineUrl` are pure path/port helpers. 13 new client tests (166 total).
- **`shell.ts` `ensureEngine`** runs once in `whenReady` BEFORE seeding: probe → decide → on `spawn`,
  `utilityProcess.fork` the bundled entry and wait for health. **Adopt-not-collide**: a reachable engine
  (the owner's dev rig on :8787) is adopted and never touched; only a child WE spawned is `kill()`ed, on
  `before-quit`. Best-effort: a failed spawn or a child that never answers degrades to the SAME tray
  "engine unreachable" state — the seam never masks failure. Data dir stays the engine default
  (`~/.openinfo/data`); only `OPENINFO_PORT` is pinned so the child answers the exact URL the client talks to.

### Runtime + native-module (ABI) decision — utilityProcess, no second Node, prebuilt binary
- **`utilityProcess` over an ELECTRON_RUN_AS_NODE fork or a bundled Node binary.** utilityProcess runs the
  engine on Electron's OWN bundled Node — so there is **no second Node runtime to ship** (smaller DMG, one
  runtime to trust) and Electron manages the child's lifecycle (clean stdout/stderr + kill-on-quit). The
  engine talks to the client over HTTP on localhost, so no IPC bridge is needed.
- **better-sqlite3 (the one native module) is rebuilt for Electron's ABI at package time.** System Node is
  ABI 141 (v25); Electron 38.8.6's Node is ABI 139 (v22.22) — a mismatch that would `ERR_DLOPEN_FAILED`
  under utilityProcess. `prebuild-install -r electron -t <electronVersion>` fetches the official WiseLibs
  **electron-v139 prebuilt** — no node-gyp/Xcode compile. This runs against a hoisted deploy under
  `release/`, so `apps/engine/node_modules` (the dev rig's system-Node build) is never disturbed.

### Packaging (`scripts/package.mjs` extended + new `scripts/dmg.mjs`)
- **Engine staged as a REPO-SHAPED `engine-bundle/` extraResource** so the engine source is consumed as-is,
  never patched. The engine reads two data files (`flag.examples.json`, `workflow.default.json`) via a
  hardcoded compiled path `dist/api → ../../../../shared/contracts/examples` (repo-relative). The bundle
  reproduces exactly that depth: `engine-bundle/apps/engine/{dist,node_modules,package.json}` +
  `engine-bundle/shared/contracts/examples/`, landing under `Contents/Resources/engine-bundle` — so the
  4-levels-up resolves inside the .app. node_modules is a `pnpm deploy --prod --config.node-linker=hoisted`
  tree (symlink-free, so nothing dangles when copied into the bundle), with `.bin` stripped.
- **`pnpm dmg`** runs the full packaging (stage bundle → @electron/packager → ad-hoc codesign) then wraps
  `openinfo.app` into `openinfo-<version>-arm64.dmg` with an `/Applications` symlink via built-in `hdiutil`
  (`ditto` copies the bundle verbatim, preserving its symlinks + ad-hoc signature). No new committed deps.
- **Signing: ad-hoc only** (no Developer ID on this machine) — a downloaded copy needs a one-time
  right-click → Open. **NOT notarized** (out of scope for 0.0.1), consistent with the research doc.

### Version
0.0.0 → 0.0.1 in root + `apps/client/package.json` (the client version drives the .app appVersion + the DMG
name). Engine/contracts/workbench stay 0.0.0 — internal workspace packages, not the release artifact.

### Tests + honest verification
`pnpm -r build && pnpm -r test` green before each commit — contracts 62, client **153 → 166** (+13 spawn
tests), engine 440. Built `release/openinfo-0.0.1-arm64.dmg` (127 MB).

**PROVEN** (executed against the shipped artifact, owner's :8787 left running throughout):
- The DMG mounts and contains `openinfo.app` + an `/Applications` symlink; a `ditto` copy out (simulated
  install) yields an app with `engine-bundle/` present (entry, examples, and the rebuilt
  `better_sqlite3.node`), Info.plist `CFBundleShortVersionString` 0.0.1, `Signature=adhoc`.
- The bundled engine BOOTS and SERVES from the installed app, on a free port (8791) with a temp data dir,
  driven by the installed app's OWN binary as Node: `/health` ok, `/fabric` returns all six slots,
  `/sessions` empty, and it writes its SQLite DB (`_meta.db`/`default.db`) — proving the rebuilt native
  module loads under the shipped Electron runtime.
- The exact **`utilityProcess.fork`** path `ensureEngine` uses spawns the installed bundle, answers `/health`,
  and is `kill()`ed cleanly by the app on quit (lifecycle ownership).
- The adopt/spawn/unreachable decision, the health probe (incl. timeout + connection-refusal), and
  wait-for-engine are all covered by the 13 headless unit tests.

**INFERRED, not executed:** launching the full packaged GUI app via `open` and observing `ensureEngine`
spawn in-process was deliberately NOT run — the owner's dev engine is live on :8787 (the app would ADOPT it,
not spawn) and a real launch registers the global ⌘\ shortcut, a tray, and TCC prompts that would disturb
the live session. The composition is thin glue over units that ARE proven: the decision matrix (unit), the
health probe (unit), and `utilityProcess.fork` of the shipped bundle (executed above).

### Deferred (out of this slice)
- **Custom app icon** — still the stock Electron diamond (cosmetic; noted in the research doc).
- **Stable self-signed cert / Developer ID + notarization** — 0.0.1 is ad-hoc-signed; grants re-prompt after
  each rebuild and Gatekeeper needs right-click → Open. The upgrade path is documented in package.mjs.
- **First-run permissions "senses" flow** — the research doc's Deliverable-2 design; a frontends-session task,
  untouched here.

## Slice: wired-up arc Phase 1 — trust & debuggability  *(on main)*

Three slices making the running system inspectable and the distill path unblockable, per the WIRED-UP ARC
directive (Phase 1: engine version handshake · probe returns proof · per-endpoint request extras). All
contracts additive; `pnpm -r build && pnpm -r test` green before each commit (the one intermittent failure
is the pre-existing `route.detect ON … sustained focus` timing test, which passes in isolation and on rerun).

### Slice 1 — engine version handshake (`api/version.ts`, `api/http.ts`, `client/main/*`)
`GET /health` gained additive optional `version` (+ optional `build`). `readEngineVersion` walks up from the
compiled module to the `@openinfo/engine` package.json, so it resolves UNCHANGED in dev and in the packaged
`engine-bundle/apps/engine/{dist,package.json}` layout (package.mjs stages that package.json). Read ONCE at
module load, echoed on every /health. `build` is an optional `OPENINFO_BUILD` env stamp (undefined in a plain
dev run — never fabricated). The engine package version was bumped `0.0.0 → 0.0.1` to match the shipped app,
so version parity is the norm and the client's skew note flags only REAL skew.

Client (main-process shell/supervisor only): `fetchEngineHealth` reads the body best-effort; pure
`compareVersions` + `engineStatusLine` (both node-tested) render the tray info line
`engine v0.0.1 · adopted at :8787` / `· spawned (bundled)`, with a plain skew note (`older than this app
(vX)` / `newer than…`) when an ADOPTED engine differs — an engine that omits the field reads as
"predates this app's version reporting". `shell.ts` captures the adopted/spawned health and feeds the line
into `TrayState.engineInfoLine`, rendered as a disabled item under the status header. `unreachable` shows no
line (the tray already leads with unreachable). This makes the stale-rig case (a launchd engine predating the
fabric fixes, which the DMG ADOPTS) visible at a glance.

### Slice 2 — the probe returns proof, not a checkmark (`api/http.ts`, `surfaces/setup/assets.ts`)
`runGenerateProbe` sent `'ping'` at `maxTokens:1` and returned only `ok` — at one token every reasoner
looked exhausted. Now it sends a real, model-answerable prompt ("We are testing access from this host —
simply respond 'yes' if you can hear us.") at `maxTokens:128`. `GenerateProbe` gained an additive optional
`sample`: the model's actual reply, trimmed + truncated (~200 chars), carried on success. The Settings Test
area renders the reply text + generation latency. The reasoning-exhausted grace is unchanged (a genuine
all-thinking response still passes with its note, no sample) — at 128 tokens that is now the exception.

### Slice 3 — `chat_template_kwargs` + `response_format` through the invoke path (`config/fabric.ts`, `fabric/invoke.ts`, `surfaces/setup/{view,assets}.ts`)
CONFIRMED biting on the rig: qwen3.5-9b burned the 700-token distill budget reasoning, distill failing on
repeat, with no way to tell the model not to think. The `http` Endpoint variant gained additive optional
`chatTemplateKwargs` (object) and `responseFormat`; `InvokeOptions` carries the same two as a per-call
override. `callHttp` includes each in the completions body ONLY when set (`opts ?? endpoint`), omitting both
entirely when unset — byte-for-byte the legacy body for existing endpoints. Nothing auto-sets
`enable_thinking` (per-endpoint user config; some templates have no such toggle, e.g. LFM2.5). The endpoint
editor exposes a minimal advanced JSON field (`.f-extras`) that round-trips `{chatTemplateKwargs,
responseFormat}`; blank sends nothing.

### Tests + verification
Contracts 62 (additive, no count change). Client 166 → 179 (+13: version parse/compare, health-fetch
best-effort, status-line wording incl. skew/spawn/unknown, tray info item). Engine 440 → 446 (+6: /health
version; probe `sample` flows through + the existing success test asserts it; callHttp includes/omits the
extras; a classify-level test proving the qwen thinking-burn is addressable via `enable_thinking:false`;
the editor row round-trips the extras field).

**Live probe proof (real LM Studio on :1234, `lfm2.5-8b-a1b-mlx`):** a temp engine on a free port ran
`POST /fabric/test` `probe:'generate'`; the probe returned `ok:true` with `sample` carrying the model's
actual reply text — proof the reply now flows end-to-end, not a checkmark. (Owner's dev engine on :8787 +
the omlx LaunchAgent left untouched throughout; that engine serves stale dist from memory — noted, not
restarted.)

### Deferred (out of this slice)
- Auto-detecting skew and offering to redeploy/restart the adopted engine — the line only SURFACES skew.
- `responseFormat` is typed `unknown` (passed verbatim); a stricter schema can land when a consumer needs it.
- Threading the extras onto the `local` Endpoint variant (managed runtimes) — the confirmed case (omlx on
  :8000) is an `http` endpoint; additive later if a managed-local runtime needs a template toggle.

## Slice: wired-up arc Phase 2 — senses on the desktop app + runtime/endpoint truth  *(on main)*

Two slices per the WIRED-UP ARC directive (Phase 2): make the desktop app ask for its senses like a
capture app and let the user debug capture; make the discovered runtimes and the endpoint editor tell the
truth. All contracts unchanged (this phase touched only client main-process modules + engine-served
surfaces); `pnpm -r build && pnpm -r test` green before each commit (the one intermittent failure is the
pre-existing `route.detect … sustained focus` timing test, which passes on rerun).

### Slice 4 — proactive first-launch permissions + debuggable capture status (`client/main/*`)
**First-launch mic ask (4a).** `askForMediaAccess('microphone')` used to fire only inside
`CaptureController.beginRun` reached from the `session.started` WS frame — so a first-run user saw no mic
popup until they started a session. `maybeAskMicOnFirstLaunch` now fires it PROACTIVELY in `whenReady`
(before any /settings auto-open), once-only via a new persisted `micPromptedAt` marker (added to
`FirstRunState` alongside `firstRunShownAt`; `first-run-store` writes are merge-writes so the two markers
coexist). It is macOS-only (off darwin `askForMediaAccess` resolves true with no popup, so we skip and
don't burn the marker), non-blocking, and independent of engine/model state — a denial degrades harmlessly
(the capture paths already run a mic-off session). The marker is written BEFORE the ask so a crash can't
re-nag; it reuses the shared in-flight permission dedup so a session that starts mid-prompt awaits the same
ask, not a second.

**Debuggable capture-status readout (4b/4c).** New pure `capture-status.ts` maps raw macOS TCC statuses
(`getMediaAccessStatus` for mic + screen) plus system-audio device presence (the capture controller's
`unavailable`/`capturing` states) into an honest per-sense readout. The tray renders it as a "Capture
status" submenu (new `TrayMenuItem.submenu` + recursive shell mapping) — mic / screen / system-audio each
show a state line + an honest detail line, and where the OS won't popup a prompt (a re-denied mic, screen
recording) a one-click link opens the exact System Settings pane (`open-screen-settings` added, mapping to
`Privacy_ScreenCapture`). Copy tells the macOS truth: mic HAS a triggerable popup; screen recording does
NOT (flip in Settings, then RELAUNCH); system-audio is device presence, not a permission (missing ⇒ install
a BlackHole-class loopback). Screen stays OFF by default (`cfg.screenEnabled`) — only its permission state
and the enable path are surfaced, never enabled. No IPC bridge was needed: the tray builds in the main
process, so the readout is assembled from state the main process already holds (statuses read live at each
tray paint, so a user's Settings flip shows on the next open).

### Slice 5 — runtime/endpoint truth in the settings UI (`engine/surfaces/settings|setup`, `api/http.ts`)
**Detected runtimes in Local runtimes (5a).** `localRuntimesBody` rendered only the download catalog
(starter llama.cpp/whisper.cpp), so a discovered mlx/omlx server — and its parakeet-class stt models — was
invisible there. New pure `localRuntimesHtml` renders the servers discovery already found (the SAME
`DiscoverResult` the Get-started lens uses): each with name/flavor, reachable / needs-key state, and its
models grouped by the capability slot their names classified into (`runtimeModelsBySlot`, canonical
ALL_SLOTS order) — so parakeet-style stt on an omlx server is finally visible. Discovered servers render as
adopted ("managed externally over HTTP", never downloaded/spawned) — the honest contrast with the
downloadable starter catalog below. Servers that did not answer are omitted (the Get-started lens diagnoses
"nothing responded"). The settings route now runs discovery for the `local-runtimes` section too (it already
did for `get-started`), keeping every other section's render cheap.

**Endpoint editor: scheme/host/port fields (5b).** The editor had one URL string; the owner's real workflow
is testing an "upgrade" from LM Studio to omlx on the SAME host under the same reference name — a port swap.
The row now renders scheme (advanced, default http) + host + port as separate fields. The stored
`Endpoint.url` shape is UNCHANGED — this is a UI affordance: pure `parseEndpointUrl`/`composeEndpointUrl`
(IPv6-aware; any trailing path/query preserved via a `data-urlrest` attribute so a URL round-trips
losslessly) split the stored url into fields on render, and the browser mirrors compose to rebuild the url
on save/test/scan. Scan reads host+port: a blank port scans the probe-list common ports on the bare host, a
filled port scans the exact composed url; a chosen scan host splits back into the fields (a port swap is one
field). Existing editor tests updated to the host/port fields.

### Tests + verification
Contracts 62 (unchanged — no contract touched). Client 179 → 189 (+10: `shouldPromptMic` + the two markers
coexisting via merge-write; `captureStatuses` mapping across every TCC state / device presence / off-macOS;
the tray Capture-status submenu lines + fix-it commands; `senseDot`; the Screen Recording settings URL +
`settingsUrlFor` mapping). Engine 446 → 454 (+8: `runtimeStateChip`/`runtimeModelsBySlot`/`localRuntimesHtml`
states incl. authRequired-shown + silent-omitted + parakeet-visible; `parseEndpointUrl`/`composeEndpointUrl`
lossless round-trip incl. IPv6 + path + the port-swap workflow). A static render check confirmed the editor
row emits scheme/host/port with no leftover `.f-url`, and the Local-runtimes block renders an adopted
omlx/needs-key server with its parakeet stt model grouped under stt.

### Deferred (out of this slice)
- A runtime toggle for `screenEnabled` (still config/env only, restart to change) — wired-up-arc Phase 3.
- Screen-recording state is read at each tray paint but the "did the user just grant it?" relaunch nudge is
  copy only; auto-detecting a fresh grant and prompting a relaunch is out of scope.
- Per-source capture ingress on the engine /settings Status section still needs engine plumbing (noted
  there already) — the client tray readout is the live capture-debug surface meanwhile.

### Slice 6 — Save profile persists (settings editor save-path regression) (`engine/surfaces/setup/view.ts|assets.ts`)
The engine-served settings editor's "Save profile" did nothing: no request, no error, edits lost on reload —
the core settings action was dead. Root cause was in the BROWSER path, not the routes (route/render tests all
passed). `editorHtml` embedded the base fabric as `escapeHtml(JSON.stringify(fabric))` inside a raw-text
`<script type="application/json" id="base-fabric">`. A `<script>` is a raw-text element — HTML entities are
NOT decoded there — so the blob reached the browser literally as `{&quot;slots&quot;…` and `saveEditor`'s
`JSON.parse(textContent)` threw (`SyntaxError` at position 1) BEFORE the save fetch: the classic silent no-op.
This predated the scheme/host/port work (present since the page was born) — the compose mirrors were never
reached. The module's own `jsonForScript` (only `<` neutralized, verbatim JSON — the JSON-in-script
convention `getStartedHtml`/`tryItHtml` already use) is the correct embed; `escapeHtml` is only correct for
the `data-profile` ATTRIBUTE, where the browser does decode entities.

Fix + honesty net: `base-fabric` now uses `jsonForScript(fabric)`; a `#save-error` strip sits beside the Save
button; `saveEditor` is wrapped so every failure (a throw, a rejected fetch, or a non-ok status) surfaces as
"save failed — <reason>" in that strip in the page's existing `.bad` style — never a silent no-op again.

Delete affordance: the per-row ✕ already worked in the DOM for every row (existing / fresh / blank); removals
never *stuck* only because Save was dead. With Save fixed, remove + Save persists, and blank/urlless rows are
filtered out of the saved fabric (they were never persisted).

Probe sample (checked, not changed): the generate-probe `sample` is truncated server-side (~200 chars,
`truncateSample`) and rendered via `probe.textContent` (inert — no JSON/HTML injection). A reasoning model's
preamble showing up as the reply is the model's own output rendered sanely, not a render bug. Cleaner
labelling/stripping of reasoning preambles is a design-pass candidate, not patched here.

### Tests + verification
Engine 454 → 461 (+7: `save-handler.test.ts`). The test drives the REAL served `SETUP_SCRIPT` (not a
reimplementation) against a tiny hand-rolled DOM shim built by PARSING the served `editorHtml`/`rowTemplateHtml`
— reproducing the exact fidelity the bug lived in (raw-text `<script>` NOT entity-decoded vs attributes
decoded). No heavy dep; runs under `node --test`. Covers existing-row edit save, fresh-row save,
blank-row delete-survives-save, blank-row filtered-on-save, save-failure surfaces text (non-ok + rejected),
and a guard that the served base-fabric blob is verbatim JSON. Reverting the fix fails 6 of 7 (no fetch fires).
Verified live end-to-end with a headless browser against a temp engine: the PUT fires and the profile document
gains the edited port + fresh endpoint (version bump), and a forced 500 shows "save failed — 500: …" in the
strip.

### Slice 7 — invisible-HUD boot race (`client/surfaces/hud`, `client/main/shell.ts|config.ts`)
The packaged app's HUD window opened COMPLETELY blank on the rig — present in the window picker with
correct bounds, renderer alive, nothing painted. Root cause: the shell creates the frameless TRANSPARENT
HUD window (and the renderer fires its one-shot fetches) BEFORE `ensureEngine()` finishes spawning the
bundled engine. The surface fetch lost that race; `void hud.start()` swallowed the rejection; the WS never
connected and never reconnected; and a transparent window with nothing painted reads as "the HUD
disappeared". Latent since the engine-spawn seam (pre-0.0.1) — masked whenever an engine was ALREADY
answering :8787 at launch (the adopt case), and biting on every spawn-case launch. Client HUD code was
byte-identical v0.0.1→v0.0.3; the "0.0.3 broke it" report was the environment flipping from adopt to spawn.

Fix (self-healing + visible, the same honesty rule as the settings save strip):
- `surfaces/hud/boot.ts` (new, pure): a boot controller — retry `start()` with capped backoff (500ms→8s,
  forever), report every state via `onStatus`, clear on success; `restart(err)` re-enters the loop when a
  runtime refresh fails.
- `dev-entry.ts`: boots through the controller; a `.hud-boot-status` chip paints the live failure
  ("waiting for engine at <url> — <reason> (retry n)") — the ONLY painted pixel while the engine is
  unreachable, so a broken HUD is never invisible. The WS transport reconnects with backoff and
  synthesizes `ws.open` per (re)connect.
- `hud.ts`: `ws.open` joins REFRESH_EVENTS (a fresh socket re-hydrates missed data); event-driven refresh
  rejections route to the new `onError` hook (previously unhandled + invisible) → boot-loop restart.
- `shell.ts`: renderer observability (did-fail-load / render-process-gone / error console lines → main
  stdout, visible when the .app runs from a terminal).
- Debug outline: `OPENINFO_HUD_OUTLINE=1` or `"hudOutline": true` in `~/.openinfo/client.json` → the shell
  passes `?outline=1` → dashed-cyan window bounds + solid-orange panel bounds (`hudOutlineStyles`). CONFIG,
  not a flag document — it must work precisely when the engine (where flags live) is unreachable.

### Tests + verification
Client 189 → 197 (+8: boot backoff ladder / status-per-failure / clean stop between attempts / restart
hook / in-flight idempotence; `ws.open` re-hydration; refresh + reload failures route to onError;
`hudOutline` precedence + file parsing). Verified in REAL Electron (a probe main with the HUD's exact
webPreferences): engine down → chip + outline paint; engine spawned 2s later → the panel paints with no
reload and the chip clears; engine killed → the painted panel stays (stale, never silently blank).

### Deferred (design pass, not this slice)
- **The fixed 708×720 transparent HUD frame ("box too big" — only the top is ever painted, the empty
  lower portion blocks clicks)** — RESOLVED by Slice 8 below (the window is now content-sized: the
  renderer measures the painted panel and the shell `setContentSize`s to match; drag/position persistence
  is unaffected because growth is top-anchored).
- The probe `sample`'s reasoning-preamble rendering (settings Test area) — inert and truncated, but a
  preamble-stripping/labelling pass would read better.

### Slice 8 — HUD content-sizing (kill the 708×720 dead zone) (`client/main/window-options.ts|hud-height.ts|shell.ts|preload.cts`, `client/surfaces/hud/auto-resize.ts`)
The HUD `BrowserWindow` was created at a fixed 708×720 and nothing anywhere ever resized it, so below the
painted bar sat ~570px of transparent, click-blocking window — the "box too big" dead zone. Root cause of
the "fixed three times, still broken" history: the earlier passes each fixed an ADJACENT bug (Slice 7's
invisible-HUD boot race, and a prior transparency override) — the `height: 720` literal was never edited,
and the real fix (content-sized windowing) had been diagnosed and explicitly deferred as a design pass in
this doc's own Slice 7 Deferred note. The window is frameless + transparent, so it can't rely on native
resize; and it has no CSS drag region either, which is why sizing (like dragging) must be driven from the
main process, not the page.

Fix — the window is now CONTENT-sized, top-anchored (origin stays put, it grows/shrinks downward, so
drag/position persistence is untouched):
- `surfaces/hud/auto-resize.ts` (new, pure over an injected element + bridge + rAF, like `window-drag.ts`):
  a `ResizeObserver` on the painted panel wrapper (NOT body/html/`.stage`, whose 100vh base would make the
  measurement self-fulfilling — the window would only ever grow) reports `ceil(panel height) + 24` (the
  stage's vertical padding) over the preload bridge. Reports coalesce to one per animation frame and dedupe
  unchanged heights so a quiet HUD never churns. Reports once immediately on the initial paint.
- `main/preload.cts`: a new `resize(height)` verb rides the same one-way `openinfoDrag` bridge as the drag
  verbs — the renderer reports the measured content height, main applies it (`contextIsolation` on,
  `nodeIntegration` off, no node surface reaches the page).
- `main/hud-height.ts` (new, pure `resolveHudHeight`): clamps a raw measurement — non-finite (a torn-down
  frame) falls back to the floor (never resize to garbage), fractional is ceiled (a floored pixel would clip
  the last row), capped at `max` (the display work-area height — never grows off-screen), floored at
  `HUD_MIN_HEIGHT`. Headless-testable so the clamp is asserted without a real window.
- `main/window-options.ts`: `height: 720` → `HUD_MIN_HEIGHT` (new export, 144 — the floor the window opens
  at and never shrinks below, tuned just under the real empty-state's measured 152px so a quiet HUD is
  content-sized exactly, not floor-padded). `resizable: false` is kept — `setContentSize` still works
  programmatically.
- `main/shell.ts`: a `hud:resize` IPC handler → `resizeHudToContent` runs `resolveHudHeight` (floor
  `HUD_MIN_HEIGHT`, ceiling = the matching display's work-area height) then `setContentSize`; unchanged
  heights are skipped. When `hudOutline` is on it logs the measured → applied bounds.
- `surfaces/hud/dev-entry.ts`: installs `installAutoResize` on the panel only inside the Electron shell
  (`g.openinfoDrag` present); a plain browser (dev-hud.html) has no bridge and stays a normal scrollable
  page.

### Tests + verification
Client 197 → 207 (+10 headless: `hud-height.test.ts` — ceil / floor-clamp / non-finite fallback / max-cap /
passthrough; `auto-resize.test.ts` — initial report, fractional ceil, change-reported-vs-unchanged-deduped
grow/shrink, disposer disconnects). Green unit tests are not proof the SERVED window resizes, so a driven
Electron e2e (`scripts/hud-bounds-e2e.mjs`, `pnpm test:e2e:hud`) launches REAL Electron with the REAL
hud.html + compiled preload against a minimal fake engine and asserts REAL window bounds follow content:
empty 152px → 12 pushed moments 398px → cleared back to 152px, each within ±4px of the painted content and
never ≥ 720. It is a "probe main" (the Slice 7 precedent) that mirrors `shell.ts`'s `hud:resize` handler
verbatim — window under test, nothing else. Needs a GUI (darwin), so it is not wired into the default
headless `test`.

## Slice: P4-T9 — STT interop seam (canonical transcript + per-flavor adapters)

The `stt` slot had one wire-shape hard-coded and one broken pipeline. `invokeStt` read `json.text` inline
for every flavor, a `local` mlx (omlx) STT endpoint threw `local runtime has no transcription path`
(the mlx `RuntimeSpec` declares none — it is `chat`/`multiModel`, not whisper-style), and even when routed
it never sent the served-model id omlx REQUIRES on `/v1/audio/transcriptions`. Adding a new engine meant a
new branch at the call site. This slice makes the ENGINE own transcript normalization behind an adapter
seam, so a new STT engine is an adapter + the CONTRIBUTING recipe, never a new invoke branch.

### The canonical contract + adapters (`fabric/stt-adapters.ts`, new)
- `TranscriptResult` — the ONE shape every flavor normalizes to: `text` ('' is valid silence, never an
  error) + optional `language`, `durationSec`, `segments` (each `{text, startSec?, endSec?}` in canonical
  SECONDS). Provenance (`endpoint`/`model`/`slot`) rides on `SttResult extends TranscriptResult`.
- Per-flavor adapters (`STT_ADAPTERS`), each owning its request shape (path · whether the `model` form
  field is sent · `response_format`) and a `normalize(body) → TranscriptResult | undefined` (undefined ⇒
  the caller raises ONE honest `bad-response`; the adapter never throws or classifies):
  - `openai` / `omlx` — `/v1/audio/transcriptions`, sends `model`, shares the OpenAI verbose_json
    normalizer (`{text, language?, duration?, segments:[{start,end,text}]}`; a `duration:0.0` is dropped
    as information-free). Distinct entries so a future omlx divergence touches only its record.
  - `whisper-server` — whisper.cpp `/inference` (NOT `/v1`), sends NO `model` (it serves one via `-m`),
    tolerates the plain `{text}` shape and converts its verbose `t0`/`t1` CENTISECONDS to canonical seconds.
- `selectSttAdapter(endpoint)` — the ONE place flavor is chosen: http `openai-compat` → `openai`; local by
  runtime (`mlx` → `omlx`, `whisper.cpp` → `whisper-server`); anything else ⇒ undefined (honest
  "unsupported", falls through in fabric order).

### Invoke rewired (`fabric/invoke.ts`)
`postTranscription` is now adapter-driven (builds the multipart request from `adapter.request`, normalizes
via `adapter.normalize`); `invokeStt` selects the adapter, resolves url + model + keyRef→bearer, and speaks
only the canonical shape. `resolveLocal` returns `{http, spec}` (the transcribePath return is gone — the
adapter owns the STT path). The local mlx path now sends the served model id + its bearer, fixing the
broken pipeline. `fabric/index.ts` re-exports the contract + adapters.

### Live verification (rig, omlx 0.4.5 on :8000, `api_d` bearer)
Drove the built `invokeStt` end-to-end against the running omlx server with a real `say`-generated WAV
("The quarterly report shipped on Thursday afternoon."). The omlx whisper model returned the OpenAI
verbose_json body, normalized to `{text, language:'en', segments:[{startSec:0, endSec:2.48}]}` — the seam
works end-to-end against a live engine. PARAKEET (`mlx-community_parakeet-tdt_ctc-110m` and every other
parakeet variant) is REJECTED by omlx 0.4.5 for stt — `Model type … not supported for stt` — surfaced by
the seam as a classified `model-load` failure, not swallowed. That is a server-side limitation of this
omlx build (parakeet STT is not wired into its transcription backend), not an engine gap: the adapter is
proven live via omlx-whisper and normalizes the identical response model parakeet will return once the
server supports it.

### Tests
Engine 461 → 474. New `stt-adapters.test.ts` (12: per-flavor normalization incl. centisecond→second
conversion, zero-duration drop, '' silence, missing-text→undefined; selection by api/runtime incl.
unsupported paddle-serving/ollama). `stt.test.ts` gains the canonical-body assertion and the local-mlx
proof (adopts a fake omlx, asserts `/v1/audio/transcriptions` + `Bearer` + the served-model form field —
the previously-broken path). `pnpm -r build` green; contracts 62 / client 207 / engine 474 pass (one
pre-existing timing-flaky route-detect test in `api/http.test.js` fails only under full parallel load,
passes isolated and on re-run — untouched by this slice).

### Out of scope (recorded, NOT built)
Two-stream mic/system-audio separation, conversation-gated merging, diarization, tiered summaries,
TTS/kokoro. This slice is the canonical transcript contract + adapters + the seam proven live only.

## Slice: #8 — wire the pins query source to the pins store

The `pinned-doc` block already shipped in the renderer and the pins store already existed (P4D:
`savePin`/`listPins`, the `pins`/`pin_chunks` tables, the ingest lifecycle over `POST /pins`), but the
query compiler still returned `[]` for `source: 'pins'` — pins shared the `ledger` arm with a "backing
store not built yet" comment. So a pinned-doc block was silently empty even against a workspace full of
ingested pins. This is a one-file reconnect: the store was there, the wire was not.

### The reconnect (`surfaces/query.ts`)
`compileQuery` splits `pins` out of the shared `ledger`/`pins` arm and resolves it exactly like the
`entities` arm — `cap(known ? store.listPins(workspaceId) : [])` — so pins hydrate workspace-scoped,
most-recently-created first (listPins order), an unknown workspace reads as `[]` (never an error), and
`top` caps/flags truncation through the shared `cap`. `ledger` keeps returning `[]` (its store is
genuinely absent, P4) with a comment that now speaks only of ledger; the `compileQuery` doc comment no
longer claims "pins P3" lands later. No contract change: `QueryResult.items` is `Type.Array(Unknown)`
and its element shape is already documented `pins→Pin` in `payloads.ts`, so `Pin[]` satisfies it as-is.

### Tests
Engine 474 → 476, client 207 → 208 (contracts 62 unchanged — no contract touched).
- `surfaces/query.test.ts` — a seeded store returns real pins through `compileQuery` (newest-first,
  `top` caps + `truncated`), a KNOWN workspace with no pins reads `[]`, and the unbuilt-store test now
  covers `ledger` alone plus an unknown-workspace `pins` read (all `[]`, never a throw).
- `api/http.test.ts` — a served-surface e2e over the live server: ingest a pin via `POST /pins`, author
  a surface carrying a `pinned-doc` block whose query is `source: 'pins'` (`PUT /layouts/surfaces/:id`),
  then GET the surface and `POST /query` for that block exactly as the client hydrates — the pin's title
  and uri round-trip back. A second `POST /query` against a pin-less workspace returns `items: []`
  (explainable-empty, not an error). This drives the exact route that was returning `[]`.
- `client/.../block-renderer/renderer.test.ts` — the render half: an on-match `pinned-doc` block that
  used to stay hidden on empty items becomes visible once its pins query hydrates, and hides again on an
  empty result (explainable-empty, never a broken card).

### Surprise (recorded)
The `pinned-doc` renderer does NOT yet consume `result.items` — it surfaces the configured
`query.params.doc` reference plus a static "ingestion & page-anchored answers land in P3" why-line. So
wiring the query source makes real pins DRIVE the block (on-match visibility, and the data is now on the
`POST /query` wire), but rendering a live per-pin excerpt/title from `items[]` is a follow-up renderer
slice (a client UI change, out of scope here). The pins-flavor future note in `features.ts` /
`surface-editor.ts` (`pins store lands in P3`) is also now stale copy — left untouched (settings/UI
files are out of scope this slice).

### Out of scope (recorded, NOT built)
Pinned-doc renderer consuming `items[]` (live excerpt/title), the stale "pins store lands in P3" copy in
the settings features/editor notes, `PUT`/`DELETE /pins/:id`.

## Slice: #41 — capture consent + renderer readiness handshake + un-wedgeable controller

Repeatedly clicking tray Start Session did nothing — no mic indicator, no chunks, zero client-side log
evidence — and quitting then reopening booted straight into a live, auto-capturing session. The capture
control path had no readiness or ack handshake anywhere, and one flag could wedge the controller
permanently. This slice makes capture ALWAYS launch stopped, gives the start path a real handshake, makes
the controller un-wedgeable, and gives the packaged app a log file so this failure class is never invisible
again. Client-only — the `POST /sessions/:id/end` route already existed.

### The mechanism that was wedging (diagnosed live)
1. `before-quit` never ended the engine session, so sessions outlived the client.
2. Next launch seeded the still-live session and `applyCaptureLifecycle(true)` fired `control.start()`
   DURING boot, racing the hidden capture window's ESM load. `control.start` was a bare optional-chained
   `webContents.send` — if the renderer had not yet registered its `capture:start` listener the send was
   silently dropped (no queue, no ack, no retry).
3. The controller set `starting` optimistically and sat there forever.
4. The next manual Start auto-ended the old session; `onSessionEnded` saw `starting`, set `stopping = true`,
   and awaited an `onCaptureStopped` ack a non-listening renderer never sent.
5. With `stopping` stuck true, every later `onSessionStarted` was swallowed into `pendingStart`. Permanent.

### What was built
- **Always launch stopped (`main/capture-consent.ts`, new).** A tiny pure `CaptureConsent`: capture only
  auto-starts on a live-session transition the USER initiated THIS launch (tray Start grants, End/quit
  revokes; consent PERSISTS across the engine's auto-end→restart). `shell.ts`'s `applyCaptureLifecycle`
  gates every source on `canAutoStart`, so a leftover live session seeded at boot opens STOPPED — the tray
  still shows it live, the user starts capture explicitly. `before-quit` also ends the live session
  (bounded, best-effort, `preventDefault`→end→quit with a 1.5s cap) so it does not outlive the client; the
  consent guard is the deterministic backstop for a force-kill where `before-quit` never runs.
- **Readiness + start-ack handshake (`main/capture-dispatcher.ts`, new).** The renderer pings
  `capture:loaded` on module load (BEFORE getUserMedia) and acks each start (`capture:start-ack`) the moment
  it receives it. The pure `CaptureDispatcher` QUEUES a start until it has heard `loaded`, then SENDS + awaits
  the ack, RESENDS on timeout up to a cap, and finally raises a VISIBLE fault instead of a silent
  forever-`starting`. `control.start/stop` for both audio sources route through it (screen keeps its
  main-process loop). A dropped/failed start now shows on the tray (`captureFault` → `tray-menu.ts`).
- **Un-wedgeable controller (`capture/capture-controller.ts`).** `onSessionEnded` arms a stop-ack timeout;
  if `stopped` never comes back, `concludeStop` force-clears `stopping` AND drains any queued
  `pendingStart` (shared with the real-ack path, so both converge identically). New `onStartFailed` drops a
  stuck `starting` back to idle when the dispatcher gives up. `render-process-gone` / `did-fail-load`
  handlers on the capture window mark the dispatcher unloaded (re-queue, don't drop), surface the fault, and
  reload the host — on the reload's `capture:loaded` capture re-arms for a consented live session.
- **Honest surfacing + log file (`main/client-log.ts`, new).** A dependency-free rotating client log
  (`<userData>/logs/client.log` → `.1` at a size cap, ~2×cap on disk, never throws) — the packaged app has
  no terminal, so capture lifecycle + failures went to a lost stdout. All capture logs + faults now flow to
  it and mirror to the console.
- **The sandbox preload bug the driven test surfaced.** `capture-preload.cts` imported the channel
  constants from the ESM sibling `./protocol.js`. A preload runs under Electron's DEFAULT sandbox, where
  `require` reaches only `electron` + builtins — so that import failed to load the WHOLE preload, leaving
  `window.openinfoCapture` undefined and every chunk unsent (a direct contributor to the reported "no
  chunks, zero log evidence"). Fixed by inlining the channel strings (the HUD preload's established
  pattern); `protocol.ts` stays the typed source of truth, guarded by a test that reads the compiled `.cjs`.

### Tests
Client 208 → 231. New unit suites: `capture-consent.test.ts` (4 — the boot guard, grant/revoke,
persist-across-restart, quit revokes), `capture-dispatcher.test.ts` (9 — dropped-start-queued-then-flushed,
send+ack, retry-then-one-fault, ack-stops-the-loop, stop cancels, renderer-gone re-queues, stale ack,
independent sources), `client-log.test.ts` (4 — append+dir, mirror, rotation bound, never-throws). The
controller suite gains the un-wedge set (stop-timeout un-wedge, pendingStart-drains-on-timeout, real-ack
clears the timer, onStartFailed, rapid cycles converge) and a self-contained-preload drift guard. `tray-menu`
gains the visible capture-fault case.

**Driven proof — `scripts/capture-lifecycle-e2e.mjs` (`pnpm --filter @openinfo/client test:e2e:capture`,
GUI-only, not in the headless default).** A probe main (the hud-bounds-e2e precedent) that launches REAL
Electron with the REAL compiled capture-preload + REAL capture-renderer against the REAL dispatcher /
controller / consent, using Chromium's fake media device so getUserMedia runs unprompted. PHASE 1 (healthy
renderer): asserts the `capture:loaded` readiness ping arrives; a live session with consent NOT granted
starts NOTHING (the boot guard holds); after the user consents the `capture:start` is delivered, the
renderer ACKS it, and capture genuinely begins (`status: ready`, only sent after getUserMedia resolves).
PHASE 2 (sabotaged renderer that loads but registers no start listener — the ORIGINAL bug): the start send
is dropped, no ack returns, and the dispatcher retries then surfaces a VISIBLE fault instead of wedging.
This is what surfaced the sandbox preload bug — route/unit tests could not have.

Known parallel-load flakes (untouched, unrelated): the engine `route.detect` timing test in
`api/http.test.ts` and the client `engine-link/seam.test.ts` TOCTOU test each fail only under full parallel
load and pass in isolation / on re-run (confirmed both). Contracts 62, engine 476 (475+1 flake), client 231
(230+1 flake). `pnpm -r build` green.

### Out of scope (recorded, NOT built)
The settings debug panel that renders the confirming signals (controller state, `stopping`/`pendingStart`,
renderer loaded-at, last start acked) — issue #41 flags it as a follow-up extending #7, and settings/UI
files are another PR's ownership. Windows/Linux capture paths. Auto-reload backoff limits on repeated
renderer crashes (one reload per crash for now).

## Slice: #40 — render hydrated pin content in the pinned-doc block

The other half of #8's DoD. #8 put real pins on the `POST /query` wire and made an on-match `pinned-doc`
block VISIBLE when its pins query hydrates — but the renderer still drew the static `query.params.doc`
reference plus a hardcoded "ingestion & page-anchored answers land in P3" why-line (P3 landed). The data
was at the door; the block never opened it. This slice is the client-only render change.

### The renderer (`client/surfaces/blocks/pinned-doc.ts`)
`renderPinnedDoc` now reads `result.items` as `Pin[]` and renders one `.rel` row per pin (mirroring the
`relevant-now`/`ledger`/`moments` list blocks): title as the `.ttl` with the pin `kind` as its `.ext`
badge, a why-line built from the pin's own ingest state (`ingested · N pages` / `ingestion pending` /
`ingestion failed`), and the copy affordance carrying `title — uri`. `block.top` caps the list exactly
like the siblings; pins arrive newest-first off the wire (#8), so the renderer does not re-sort. With
zero hydrated pins it falls back to the configured `params.doc` reference + an explainable
`configured reference · awaiting a matching pin` why-line, so an always-visible card never shows a blank
body — an `on-match` block just stays hidden (`renderSurface` skips it). No contract change.

### Stale-copy sweep (copy-only, no logic)
Removed the now-false "pins store lands in P3" future-notes (the pins store landed in #8): the
`FUTURE_STORE_NOTE` map in `engine/surfaces/setup/surface-editor.ts` and its browser twin
`futureNote()` in `editor-assets.ts` drop their `pinned-doc`/`hint` entries (both hydrate today; the map
already documented "absent ⇒ no note"), keeping only `ledger` (P4). The `surface.block.pinned-doc`
feature note in `settings/sections/features.ts` now describes the hydrated render + fallback instead of
"present-but-future".

### Tests + verification
Client 208, contracts 62, engine 476 (all unchanged in count — this slice extends existing assertions
rather than adding test cases; no contract or engine logic touched).
- `client/.../block-renderer/renderer.test.ts` — the hydrated case now seeds a pin whose title
  (`SOC 2 Type II report`) deliberately DIFFERS from `params.doc` (`configured placeholder`) and asserts
  the store-derived title renders while the configured reference does NOT, plus the ingest why-line
  (`ingested · 42 pages`) and the copy text (`title — uri`); empty store still hides the on-match block.
  The fallback-degradation test keeps asserting the configured reference shows on an empty always-block.
- `engine/surfaces/setup/surface-editor.test.ts` — flipped the pinned-doc assertion: the row now carries
  NO `lands in P` future-note (ledger still does).
- Re-ran the #8 served e2e `api/http.test.ts` ("a pinned-doc surface hydrates its pins block over
  POST /query") in isolation — green, wire contract unchanged.
- `route.detect ON` is the known parallel-load timing flake: fails under `pnpm -r test`, passes in
  isolation (confirmed both runs).

### Out of scope (recorded, NOT built)
The `hint` block renderer's own `items[]` shape (it reads `{text,excerpt}`, pins carry `{title,uri}`) and
its stale P3 doc-comment — left untouched; #40 names only the pinned-doc renderer. `PUT`/`DELETE /pins/:id`.

## Slice: #43 — copy action reports its outcome honestly (no silent no-op)

Copy buttons "weren't working" — clicked, nothing happened, no error. The event delegation was sound
(`block-renderer/mount.ts` wires ONE listener on the container, survives re-render), so the failure was
downstream in the injected `CopyFn`: the shell's `clipboardCopy` (`hud/dev-entry.ts`) was
`void nav?.clipboard?.writeText(text)` — a missing Clipboard API (insecure context / no renderer
permission) made the optional chain evaluate to `undefined` and `void` swallowed it, and even when
present a rejected `writeText` promise was discarded. No fallback, no feedback: a failed copy was
indistinguishable from a dead button. `/settings` (engine-served) has no copy affordance, so nothing to
do there. Copy is the only action verb wired to a real effect, so this is where honest action-verbs start.

### Honest outcome (`hud/dev-entry.ts`)
`clipboardCopy(nav, doc)` now: tries `navigator.clipboard.writeText`; on a missing API OR a rejected
write, falls back to the temp-`<textarea>` + `document.execCommand('copy')` path (synchronous — append,
select, copy, remove in one tick, no repaint/flash); resolves ONLY on a confirmed write and otherwise
REJECTS. The outcome is now a real promise the caller can read, not a swallowed value.

### Feedback at the mount altitude (`block-renderer/mount.ts`)
The visible feedback lives in `wireActions`, NOT the HUD entry — this is the better altitude the issue
called for: every surface mounted through `wireActions` gets it, not just the browser dev entry, and the
public `CopyFn` seam stays untouched (`(text) => void | Promise<void>`). `paintCopyFeedback` awaits the
copy outcome (`Promise.resolve(outcome).then(ok, fail)`) and flips the clicked button's label to
`Copied` / `Copy failed` plus a `copied` / `copyfail` class (styled in `hud/styles.ts`, matching the
`.hud-boot-status` "never fail invisibly" idiom), reverting after ~1.2s (an unref'd timer — browser
timers have no `unref`, so it never holds a node process open) or on the next live re-render, which
simply repaints the button and discards a stale transient state. Driven by the real result, not
fire-and-forget. The structural `MountClickEvent` element type gained `textContent`/`className` (both on
every real DOM Element, so a live button satisfies it with no cast).

### Tests + verification
New file `client/surfaces/hud/copy-feedback.test.ts` (7 driven tests) — wires the REAL `clipboardCopy`
through the REAL `wireActions` (not just markup assertions):
- copy verb delegated AFTER a `renderInto` re-render, carrying the exact `data-copy` text to the injected
  `CopyFn`; a non-copy verb stays inert.
- working clipboard → the exact text reaches `writeText` AND the button paints `Copied`/`.copied`.
- unavailable clipboard + failing `execCommand` fallback → the button paints `Copy failed`/`.copyfail` —
  the never-silent guarantee.
- `clipboardCopy` unit outcomes: resolves via the async API forwarding the exact text; falls back to the
  textarea when the API is absent; falls back when the API rejects (denied/insecure); rejects when every
  path fails.
- Did NOT touch `renderer.test.ts` (a parallel PR is active there).
- `pnpm -r build` green; `pnpm -r test`: client 238 (was 231; +7 here), the one red is the known
  `engine-link/seam.test.ts` client-seam TOCTOU parallel-load flake — passed 3/3 on isolated rerun.

### Out of scope (recorded, NOT built)
A shared toast/affordance for the still-inert verbs (dismiss/mark-done/draft-with have no write path yet
— PHASE2-NOTES); a `navigator.permissions` pre-check (the try/await-or-fallback already covers denial).

## Slice: #9 — todos block + query source

The pipeline already extracted follow-ups (`task-extract`, P4A) into versioned to-do documents and served
them over `GET/PUT /todos[/:sessionId]`, and `{{todo}}` already un-constrained them into drafts — but no
block rendered them, so a user could not put their running task list on a panel. This is the missing
block plus its query source (the `add-a-block` "new built-in block type" recipe: contract union append +
new `BlockQuery` source + `compileQuery` arm + renderer + registry entry).

### Contract (append-only, schemas regenerated)
`BlockTypeName` gains `todos`; `BlockQuery.source` and `QueryResult.source` each gain `todos`. All three
are append-only unions (existing members untouched), so every prior document still validates. Ran
`pnpm --filter @openinfo/contracts gen` — the language-neutral `schemas/*.json` artifacts for
`BlockTypeName`/`BlockQuery`/`QueryResult`/`Block`/`Surface` regenerated with the new member (unrelated
pre-existing schema drift left untouched). `QueryResult.items` stays `Type.Array(Unknown)`; the element
shape for `todos→TodoItem` is documented in the arm, so no structural contract change beyond the source
names. A `surface.todos.json` example exercises the block (validated by `contracts.test`).

### The query source (`surfaces/query.ts` + `store/workspaces.ts`)
New store read `listTodos(workspaceId, sessionId?)`: to-do lists are DOCUMENTS (global `_meta.db`, keyed
by session id, workspace on the body — where `TodoDocuments` writes), so unlike the per-workspace record
sources it walks `layouts.latestOfKind('todo-list')` and filters by the body's `workspaceId`/`sessionId`.
The `compileQuery` `todos` arm flattens each resolved list to its ITEMS (one row per follow-up, in
accumulation order — the same order `{{todo}}` reads) and caps/flags truncation through the shared `cap`.
Deliberately NOT gated by the `known` (workspace-DB-exists) guard the record sources use: a to-do document
exists without a workspace DB (`PUT /todos` writes the document, not a workspace), and `listTodos` already
filters by the body's workspace — an unknown workspace / no extraction yet reads `[]`, explainable-empty,
never an error. `session: current` binds to the live session exactly like the other arms.

### The renderer (`client/surfaces/blocks/todos.ts` + registry)
`renderTodos` reads `result.items` as `TodoItem[]` and renders one `.rel` row per item (mirroring the
sibling list blocks): the text as `.ttl`, a STATUS marker (`✓` + struck `.ttl.done` for a checked item,
`○` for open), and a why-line derived from the item's provenance — an item with a distillate/moment
behind it reads `from the meeting`, a hand-added one `added by you` (TodoProvenance's two-authors note),
a done item prefixes `done · `. `block.top` caps like the siblings. Empty is EXPLAINABLE, not silent: an
always-visible block with no items renders a `No follow-ups yet` line rather than a blank card; an
`on-match` block just stays hidden (`renderSurface` drops it first). Registered in `defaultBlockRegistry`;
the settings surface-editor picker gains a `todos` default-block seed (`show: on-match`, `session:
current`, `top: 20`) so choosing it splices a real todos block, not a `custom` fallback.

### Tests + verification
Contracts 62→63, engine 476→478, client 233→234 (all green in isolation).
- `surfaces/query.test.ts` — a store seeded via `TodoDocuments` across two sessions in one workspace plus
  a list in a DIFFERENT workspace: the arm flattens only the resolved workspace's items, narrows to one
  session, `top` caps + flags truncation, and a known-but-todo-less workspace reads `[]`; the
  unbuilt-store test also covers an unknown-workspace `todos` read (`[]`, never a throw).
- `api/http.test.ts` — a served e2e over the live server: `PUT /todos/:sessionId` authors a list, a
  surface carries a `todos` block (`PUT /layouts/surfaces/:id`), then GET + `POST /query` hydrate exactly
  as the client does — text, `done` status and provenance round-trip; a todo-less workspace query returns
  `items: []`.
- `client/surfaces/blocks/todos.test.ts` (OWN new file — `renderer.test.ts` untouched, a parallel PR owns
  it) — proves STORE-DERIVED content: seeded item text only reachable via `result.items`, the ✓/○ status
  markers + struck done title, the three provenance why-lines, and the copy affordance carrying the item
  text; plus the explainable-empty line on an always-block and the hidden on-match empty block.
- Known parallel-load flakes confirmed (fail under `pnpm -r test`, pass in isolation): engine
  `route.detect ON`; client engine-link seam `spools while engine is down` (TOCTOU).

### Out of scope (recorded, NOT built)
A `mark-done`/toggle affordance that writes back through `PUT /todos` (this slice renders status
read-only; the action button is inert like the other non-copy verbs). Semantic dedupe of items (WART
already recorded in `act/todo.ts`). The drafts block (#10, stacked on this branch).

## Slice: #10 — drafts block + query source

Stacked on #9. The Act pass (P2) already prepared follow-up drafts at session end and served them over
`GET /drafts`, but no block rendered them, so a prepared draft lived nowhere a user could see it. This is
the drafts block + its query source — the same `add-a-block` "new built-in block type" shape as #9.

### Contract (append-only, schemas regenerated)
`BlockTypeName` gains `drafts`; `BlockQuery.source` and `QueryResult.source` each gain `drafts`. Append-only
(prior documents still validate). Ran `pnpm --filter @openinfo/contracts gen` — the affected
`BlockTypeName`/`BlockQuery`/`QueryResult`/`Block`/`Surface` `schemas/*.json` regenerated (unrelated
pre-existing schema drift left untouched). A `surface.drafts.json` example exercises the block.

### The query source (`surfaces/query.ts`)
The `drafts` arm reads the EXISTING `store.listDrafts(workspaceId, sessionId?)` — drafts are
workspace-level RECORDS in the workspace DB, so unlike todos this arm mirrors the record sources: it is
`known`-gated (unknown workspace ⇒ [], never an error) and session-scopable via `session: current`.
`listDrafts` returns oldest-first (creation order); the HUD wants the freshest prepared draft on top, so
the arm reverses to newest-first (like moments/pins) before the shared `cap` takes top-K / flags
truncation. No new store method needed.

### The renderer (`client/surfaces/blocks/drafts.ts` + registry)
`renderDrafts` reads `result.items` as `Draft[]` and renders one `.rel` row per draft: the draft BODY as
the `.ttl` and a PROVENANCE why-line built from the draft's own trail — its act kind, the source
distillate + moment counts it was composed from, and the fabric endpoint that produced it (product
principle 1: inspectable back to what it was built from). The copy affordance carries the body (prepared,
never sent — the human executes). `block.top` caps like the siblings; empty is explainable (a "No drafts
prepared yet" line on an always-block, hidden when `on-match`). Registered in `defaultBlockRegistry`; the
surface-editor picker gains a `drafts` default-block seed (`show: on-match`, `session: current`, `top: 3`).

### Tests + verification
Contracts 63→64, engine 478→480, client 234→237 (full `pnpm -r test` green, no flakes this run).
- `surfaces/query.test.ts` — a store seeded via `saveDraft` across two sessions: the arm hydrates
  newest-first, `top` caps + flags truncation, narrows to one session, and a draft-less/unknown workspace
  reads `[]`; the unbuilt-store test also covers an unknown-workspace `drafts` read.
- `api/http.test.ts` — a served e2e over the live server. Drafts have NO served write route (they are
  prepared at session end, never posted), so the test drives the whole PRODUCING pipeline (start →
  capture → distill → end → follow-up draft via the fake llm), then authors a surface with a `drafts`
  block and `POST /query`s it exactly as the client hydrates — the prepared body + provenance round-trip;
  a draft-less workspace query returns `items: []`.
- `client/surfaces/blocks/drafts.test.ts` (OWN new file — `renderer.test.ts` untouched) — proves
  STORE-DERIVED content: the seeded body only reachable via `result.items`, the provenance why-line
  (`follow-up draft · from 2 distillates + 1 moment · via llm.fast`), the copy affordance carrying the
  body, and both empty-state paths.

### Out of scope (recorded, NOT built)
A `draft-with`/regenerate affordance or any write-back (this slice renders drafts read-only; only the copy
verb is live). Markdown rendering of the draft body (shown as text, consistent with the other blocks).

## Slice: #11 — teach-candidates / hint-review block + query source

The teach loop's capture side and serving API already existed — `session.rerouted` corrections are recorded
as `teach-signals`, `deriveHintCandidates` turns them into SUGGESTED attribution-hint patterns, and `GET
/teach/candidates` + `GET`/`PUT /hints` serve/apply them — but the REVIEW half had no UI: candidates were
derived read-only and never surfaced on a panel for a human to weigh. This is the missing block plus its
query source (the `add-a-block` "new built-in block type" recipe: contract union append + new `BlockQuery`
source + `compileQuery` arm + renderer + registry entry).

### Contract (append-only, schemas regenerated)
`BlockTypeName` gains `teach`; `BlockQuery.source` and `QueryResult.source` each gain `teach`. All three are
append-only unions (existing members untouched), so every prior document still validates. Ran `pnpm --filter
@openinfo/contracts gen` — the language-neutral `schemas/*.json` for `BlockTypeName`/`BlockQuery`/
`QueryResult`/`Block`/`Surface` regenerated with the new member; the 8 unrelated schemas the generator
rewrites from known pre-existing drift (DiscoverResult/Endpoint/EndpointProbe/Fabric/FabricProfile/
GenerateProbe/Health/ProbeList) were reverted, matching the #9/#10 slices. `QueryResult.items` stays
`Type.Array(Unknown)`; the element shape for `teach→HintCandidate` (already a contract, served by
`/teach/candidates`) is documented in the arm. A `surface.teach.json` example exercises the block.

### The query source (`surfaces/query.ts`)
New `teach` arm: `deriveHintCandidates(new TeachStore(store).list(workspaceId))` — the SAME pure derivation
`GET /teach/candidates` serves, so a teach block renders the identical inspectable, citable candidates the
review surface would. Workspace-scoped only (a candidate teaches the workspace it was corrected TO — there
is no session dimension). Deliberately NOT gated by the `known` (workspace-DB-exists) guard the record
sources use: like `todos`, the teach signals are DOCUMENTS keyed by workspace (global `_meta.db`, not a
workspace DB), and `TeachStore.list` reads `[]` for a workspace with no recorded corrections — an unknown
workspace / no reroutes yet reads `[]`, explainable-empty, never an error. Candidates arrive support-sorted
(deterministic); the shared `cap` takes top-K + flags truncation. READ-ONLY: the arm never writes hints and
touches no route/ logic — the loop SUGGESTS, the user reviews and applies (the accept write path is the
action-verbs slice).

### The renderer (`client/surfaces/blocks/teach.ts` + registry)
`renderTeach` reads `result.items` as `HintCandidate[]` and renders one `.rel` row per candidate (mirroring
the sibling list blocks): the suggested match rule as `.ttl` (the humanized focus field + the substring the
reroutes agreed on — `window contains "…"`, `repo contains "…"`), and a `.why` line built from the
candidate's own trail — how many distinct corrections support it and which workspace it would teach
(`supportCount` is the confidence; every candidate is traceable to its `sampleSessionIds`). The block's
`actions` render through `actionButtons` (the copy verb carries the pattern text; the accept/dismiss verbs
render visible-but-inert until the write path lands — mirroring the other blocks' non-copy verbs).
`block.top` caps like the siblings. Empty is EXPLAINABLE, not silent: an always-visible block with no
candidates renders a "nothing to review yet" line rather than a blank card; an `on-match` block just stays
hidden. Registered in `defaultBlockRegistry`; the settings surface-editor picker gains a `teach`
default-block seed (`show: on-match`, workspace-scoped, `top: 5`) so choosing it splices a real teach block.

### Tests + verification
Contracts 64→65, engine 480→482, client 244→247 (all green in isolation, and the full engine suite ran green
end to end this run).
- `surfaces/query.test.ts` — a store seeded via `TeachStore` with three reroutes into one workspace (two
  agreeing on the same window title ⇒ support 2, one repo ⇒ support 1) plus a fourth into a DIFFERENT
  workspace: the arm derives only the resolved workspace's candidates, support-sorted, traceable to their
  sessions, `top` caps + flags truncation, and an untaught workspace derives `[]`; the unbuilt-store test
  also covers an unknown-workspace `teach` read (`[]`, never a throw).
- `api/http.test.ts` — a served e2e over the live server: `TeachStore` seeds two agreeing reroutes (the real
  capture seam — there is no write route), a surface carries a `teach` block (`PUT /layouts/surfaces/:id`),
  then GET + `POST /query` hydrate exactly as the client does — the SUGGESTED pattern + support + traceable
  sessions round-trip; the query never applied the candidate (the workspace's hints doc stays untouched);
  an untaught workspace query returns `items: []`.
- `client/surfaces/blocks/teach.test.ts` (OWN new file — `renderer.test.ts` untouched) — proves
  STORE-DERIVED content: seeded pattern text only reachable via `result.items`, the humanized field labels,
  the singular/plural support why-line, and the accept/dismiss affordances (copy carrying the pattern);
  plus the explainable-empty line on an always-block and the hidden on-match empty block.

### Out of scope (recorded, NOT built)
The APPLY/accept write path (a verb that PUTs the reviewed pattern into the workspace's `WorkspaceHints`) —
tracked by the action-verbs issue; this slice renders the affordances inert (only `copy` is live). A
`dismiss`-kind teach signal that suppresses a candidate (the `TeachSignalKind` union's deferred member).
The transcript/distillate block (#12) and the queue/status block (#13), stacked on this branch.

## Slice: #12 — transcript / distillate stream block + query source

Transcript results already flow through the pipeline (the three STT adapters, wired pre-distill) and
distillates already persist as workspace records, but no block put the raw stream on a panel — moments
render (`source: moments`), yet the distilled-window stream underneath them had no dedicated block. This is
that block plus its query source (the `add-a-block` "new built-in block type" recipe: contract union append
+ new `BlockQuery` source + `compileQuery` arm + renderer + registry entry).

### Store-shape decision (honest subset)
The issue frames it as the "transcript / distillate stream". Raw pre-distill transcripts are TRANSIENT: the
`distill.transcribe` stage rewrites base64 audio chunks to utf8 text IN-FLIGHT, before the distiller, with
**no persistence path** for transcribed-but-undistilled text (documented in `api/http.ts` — running stt when
nothing will distill it is pure waste, so it is gated inside `distill.enabled`). `TranscriptResult` is an
internal `stt-adapters.ts` interface, not a stored contract. What IS durable and queryable is the
DISTILLATE — the merge-window summary the distiller persists per session (`saveDistillate` → the workspace
DB), which is also what feeds moments/entities downstream. So the source is named `distillates` (block type
== source, matching the `todos`/`drafts` precedent) and renders the persisted distillate stream — the honest
substance of the "transcript/distillate stream". Disclosed here and in the PR body.

### Contract (append-only, schemas regenerated)
`BlockTypeName` gains `distillates`; `BlockQuery.source` and `QueryResult.source` each gain `distillates`.
Append-only unions (existing members untouched). Ran `pnpm --filter @openinfo/contracts gen`; the 5 affected
schemas (`BlockTypeName`/`BlockQuery`/`QueryResult`/`Block`/`Surface`) regenerated, the 8 unrelated
pre-existing-drift schemas reverted (as in #9/#10/#11). `QueryResult.items` stays `Type.Array(Unknown)`; the
element shape for `distillates→Distillate` (already a contract) is documented in the arm. A
`surface.distillates.json` example exercises the block.

### The query source (`surfaces/query.ts`)
New `distillates` arm reads `store.listDistillates(workspaceId, sessionId)` — workspace-DB records, so it
mirrors the record sources: `known`-gated (unknown workspace ⇒ [], never an error), session-scopable.
`listDistillates` returns them oldest-first (creation order); the stream reads NEWEST-first (mirroring the
`moments` arm's ordering — hud-v2.html's stream), so the arm reverses before `cap` takes top-K + flags
truncation.

### The renderer (`client/surfaces/blocks/distillates.ts` + registry)
`renderDistillates` reads `result.items` as `Distillate[]` and renders one `.rel` row per window: a clock
label (`clockLabel(windowEnd)`, the same formatter the moments block uses) as the `.mk t` timestamp, the
distilled text as `.ttl`, and a `.why` line naming the producing endpoint (every summary inspectable back to
what produced it). The block's `actions` render through `actionButtons` (copy carries the window text).
`block.top` caps like the siblings. Empty is EXPLAINABLE, not silent: an always-visible block with no windows
renders a "no distilled windows yet" line; an `on-match` block stays hidden. Registered in
`defaultBlockRegistry`; the surface-editor picker gains a `distillates` default-block seed (session-scoped,
`top: 20`, uncollapsed — a stream reads best expanded).

### Tests + verification
Contracts 65→66, engine 482→484, client 247→250 (all green in isolation).
- `surfaces/query.test.ts` — a store seeded via `saveDistillate` across two sessions in one workspace: the
  arm returns them newest-first, narrows to one session, `top` caps + flags truncation, and a
  known-but-distillate-less workspace reads `[]`; the unbuilt-store test also covers an unknown-workspace
  `distillates` read (`[]`, never a throw).
- `api/http.test.ts` — a served e2e over the live server: `saveDistillate` seeds two windows (the distiller's
  own persistence path — there is no POST /distillates route), a surface carries a `distillates` block
  (`PUT /layouts/surfaces/:id`), then GET + `POST /query` hydrate exactly as the client does — the window
  text + timestamp round-trip NEWEST-first; a distillate-less workspace query returns `items: []`.
- `client/surfaces/blocks/distillates.test.ts` (OWN new file — `renderer.test.ts` untouched) — proves
  STORE-DERIVED content: seeded window text only reachable via `result.items`, the per-row timestamp
  (`clockLabel` of `windowEnd`), the endpoint why-line, and the copy affordance; plus the explainable-empty
  line on an always-block and the hidden on-match empty block.

### Out of scope (recorded, NOT built)
Persisting the raw pre-distill transcript so it could have its OWN stream distinct from the distillate
stream (there is no persistence path today — a deliberate distill-hygiene decision; a `transcript` source
would need one first). A speaker/me-them split on the row (distillates merge a window; the me/them channel
split lives upstream on the audio chunks). The queue/status block (#13, stacked on this branch).

## Slice: #13 — queue / status block (honest backlog + last failure on a panel)

The work queue already served honest backlog telemetry over `GET /queue` (per-kind depth, ETA, overflow, and
the classified last failure — the honest "why nothing arrived"), but none of it was renderable on a panel. A
queue/status block lets a user put the real backlog and last failure in front of themselves — directly
supporting the honest-failure-surfacing mandate. This is that block plus its query source.

### Store-shape decision (the one documented exception to the store-read rule)
Every other query source reads exclusively through `store/` (the DB-handle rule). The `queue` source cannot:
queue status is OPERATIONAL ENGINE STATE — `lastFailure`, drain samples, and per-kind depth are ephemeral
runtime facts the `CaptureQueue` holds in memory (spool.ts explicitly justifies them as NOT documents), so
there is no store record to read. So `compileQuery` gains an optional `sources: QuerySources` parameter, and
the `/query` route injects `ctx.queue.status()` for the `queue` source (awaited only when the source is
`queue`). The arm returns ONE row — the whole `QueueStatus` snapshot. No status injected (a unit caller, or
the queue unwired) ⇒ `[]`, explainable-empty, never an error. This is disclosed in the PR body as the honest
deviation from the pure store-read precedent. Workspace/session params don't scope it (the spool is global).

### Contract (append-only, schemas regenerated)
`BlockTypeName` gains `queue`; `BlockQuery.source` and `QueryResult.source` each gain `queue`. Append-only
unions. Ran `pnpm --filter @openinfo/contracts gen`; the 5 affected schemas regenerated, the 8 unrelated
pre-existing-drift schemas reverted (as in #9–#12). The row shape (`queue→QueueStatus`, already a contract)
is documented in the arm. A `surface.queue.json` example exercises the block.

### The renderer (`client/surfaces/blocks/queue.ts` + registry)
`renderQueue` reads `result.items[0]` as `QueueStatus` and renders the live telemetry: a status row (per-kind
backlog depth · honest ETA · overflow policy) and — when present — a SEPARATE, marked failure row (`.rel.fail`)
carrying the last failure as VISIBLE text: its class, endpoint, the server's own verbatim message, and the
one-line fix hint. The ETA line is honest about `basis` — `none` reads "not enough data yet" and NEVER invents
a number. The overflow line notes when a policy is declared-but-inert (`enforced: false`). A failure/backlog
therefore can never render as an empty or silent block; an idle failure-free queue still renders its status
(a status panel is never silent); a missing status row (queue unwired) renders an explainable "status
unavailable" line rather than a blank card. Registered in `defaultBlockRegistry`; the surface-editor picker
gains a `queue` default-block seed (`show: always` — status is always worth showing).

### Tests + verification
Contracts 66→67, engine 484→486, client 250→253 (all green in isolation).
- `surfaces/query.test.ts` — the `queue` arm returns ONE row from an INJECTED `QueueStatus` (with a seeded
  last failure), and reads `[]` when no status is injected; the unbuilt-store test also covers a no-status
  `queue` read.
- `api/http.test.ts` — a served e2e over the live server that drives a REAL model-load failure (fake chat
  server returns "Model failed to load", the drain re-queues and records WHY), authors a surface with a
  `queue` block, then GET + `POST /query` hydrate as the client does — asserting the idle queue still
  hydrates one status row, and that after the failure the classified `lastFailure` (class `model-load`,
  endpoint, the smaller-model hint) rides through the query pipeline VISIBLE, never hidden.
- `client/surfaces/blocks/queue.test.ts` (OWN new file — `renderer.test.ts` untouched) — proves the
  per-kind backlog / honest ETA / overflow render from `result.items[0]`; that a SEEDED FAILURE renders as
  visible text (class · endpoint · verbatim server message · hint, in a marked `.rel.fail` row); that a
  `none` ETA basis fabricates no number; and that a missing status stays explainable.

### Out of scope (recorded, NOT built)
A live-updating queue block driven by the `queue.updated` WS event (this slice renders on the same POST
/query hydration path as the other blocks; the HUD controller's WS re-hydration already refreshes it). A
`retry`/`flush-now` action verb on the block (the write path is the action-verbs slice). Per-kind ETA (the
drain processes whole mixed-kind files, so the observed rate is mixed — recorded on `BacklogEta`).

## Slice: #14 — render recorded provenance as the relevant-now why line

Provenance is RECORDED on the moment/entity/draft/todo contracts, but the heart-of-the-HUD block
(`relevant-now`) built its one-line WHY from a re-guessed heuristic — the mention count plus the latest
joined moment's text — never from the provenance the pipeline actually stored (which distillate/window/
endpoint/model named the entity). This slice wires the RECORDED trail into the why line so the card
explains itself from the truth the pipeline stored, with the heuristic kept as an honest fallback.

### The derivation (`client/surfaces/blocks/relevant-now.ts`)
`whyLine` now: (1) looks for RECORDED provenance — the entity's own `provenance` trail wins (most recent
window entry), else the first joined moment that carries a `provenance` object; (2) when present, builds
the sentence from THAT object — `via <endpoint>[ · <model>] · <window-clock>`, where the window clock is
the `windowEnd`/`windowStart` rendered through the shared `clockLabel` (a multi-window trail with no
window timestamps reads `via <endpoint> · N windows`); (3) when NO provenance was recorded anywhere
(Phase-0 rows, or a merge with an empty trail), falls back to the existing `Referenced N× · <latest
moment>` / `last seen <clock>` heuristic UNCHANGED. `EntityProvenance`/`MomentProvenance` share the
`{ endpoint, model?, windowStart?, windowEnd?, slot }` envelope, so ONE derivation reads both.

Display rule #1 is now enforced structurally: `whyLine` returns `undefined` when NEITHER a recorded trail
NOR the heuristic can state a sentence (no provenance, no mentions, no moments, an unparseable
`lastSeen`), and `renderRelevantNow` DROPS such a row instead of rendering a why-less shell — the first
block to make "no why ⇒ no card" a hard filter rather than a soft always-there fallback string.

### Contract (additive, no schema regeneration)
`records/moment.ts` gains `export type MomentProvenance = Static<typeof MomentProvenance>` — the value
schema already existed and rode out via `export *`, but only the type export was missing (its
`EntityProvenance` sibling already had both). Purely additive; no `$id` schema JSON changed, so the
generator was not run.

### Tests + verification
Contracts 67 (unchanged), client 253→254 (all green in isolation; one engine parallel-load flake cleared
on isolated rerun — 486/486). One new headless renderer test in `renderer.test.ts` asserts all three
paths on ONE render: a row with an `entity.provenance` trail renders `via distill-fast · qwen3-4b · 2:46p`
(the most-recent window) and NOT the mention-count phrasing; a row with no recorded trail renders the
`Referenced 3× · <moment>` heuristic; and a why-less row (no provenance/mentions/moments + an unparseable
`lastSeen`) renders NO `.rel` card — exactly two cards for three rows.

### Out of scope (recorded, NOT built)
Rewriting the OTHER blocks' hand-rolled why-lines (todos "from the meeting/added by you", drafts, teach,
distillates, queue) onto a single shared provenance renderer. Each already derives its why from its own
record's provenance-ish fields; unifying them behind one helper is a refactor with no user-visible change
and is out of this slice's scope (the issue names `relevant-now` specifically — the one block still on a
re-guessed heuristic). The recorded `distillateId`/`slot` are available on the provenance object but left
out of the rendered sentence (endpoint · model · window is the inspectable minimum; the id is a lookup
key, not a human why).

## Slice: #15 — wire the inert action verbs to their real write paths

Blocks declared up to seven action verbs but only `copy` was live; every other verb rendered as a
visible-but-inert button (the honest placeholder #11 shipped, explicitly waiting for this slice). Several
verbs now have real engine write paths, so this connects them — making panel actions actually DO
something — while holding the #43 honesty line: every wired verb reports its ACTUAL write outcome as
visible text, and a verb with no honest write path stays inert rather than falsely live.

### What got wired (and what stayed honestly inert)
- **`mark-done` → `PUT /todos/:sessionId`.** Read-flip-write: load the session's `TodoList`, flip the
  addressed item's `done`, PUT the whole edited document back (the route takes a full `TodoList`, versioned
  + history-preserving). The todos block renders the verb LIVE only when the item carries
  `provenance.sessionId` (the PUT address — stamped by `act/todo` on every extracted item); a hand-added
  item with no session trail leaves the button inert rather than firing a write it can't address.
- **`accept` → `PUT /hints/:workspaceId`** (NEW verb, see contract below). The APPLY half of the teach
  loop: read the workspace's hints doc (unknown workspace → 404 → start a fresh empty doc, mirroring the
  engine's PUT-creates policy), append the candidate's pattern (idempotent), PUT it back. The teach
  candidate row is self-sufficient — it carries both the target workspace and the exact pattern — so the
  mount layer needs nothing else from the DOM.
- **`dismiss` — stays inert (disclosed deviation).** The issue lists `dismiss → the teach/hints write
  path`, but teach candidates are DERIVED read-only from reroute corrections on every read; there is no
  dismissed-candidate store, so a client-only dismissal would silently reappear on the next refresh —
  falsely live is worse than honestly inert. Wiring it needs a suppression store (a future slice). The
  honest teach write this slice CAN make is APPLY, so it owns the new `accept` verb instead.
- **`open`/`navigate` — stay inert (disclosed deviation).** The issue lists these too, but the app has no
  navigation destination yet (the HUD is the only surface; there is no workbench/entity route to open
  into, and entities carry no URL). Rendering them live would fire into nothing. Left inert, documented,
  until a navigable surface exists — same honest-placeholder posture as #11.
- **`run-mode`/`draft-with` — untouched, no write path this slice.**

### The mount seam (`client/surfaces/block-renderer/mount.ts`)
`wireActions(target, copy)` became `wireActions(target, handlers: ActionHandlers)` where `ActionHandlers =
{ copy: CopyFn; markDone?; accept? }`. The copy-only `paintCopyFeedback` generalized to `paintFeedback(el,
outcome, { ok, fail })` — same transient label/class flip driven by the real promise outcome, reused for
every verb (the `copied`/`copyfail` classes are just the green/red success/failure flip). The delegated
listener (survives innerHTML replacement) now dispatches per verb, reading each verb's payload off
data-attributes; a verb whose handler is absent or whose button lacks its payload is left untouched. The
write ORCHESTRATION lives in `hud/dev-entry.ts` as injectable `markTodoDone(baseUrl, fetch)` /
`acceptHintCandidate(baseUrl, fetch)` (read-then-write, REJECT on any non-ok HTTP so the paint shows
failure); `startHud` constructs them against the engine base URL and passes them into `mountSurface`.

### Payload rendering (`client/surfaces/blocks/actions.ts` + todos/teach)
`actionButtons(actions, copyText, wired?)` now stamps the per-verb write payload as data-attributes and
styles a button LIVE (`.mini`) iff it is a wired verb AND the block supplied its payload — else
visible-but-inert (`.mini ghost`). `mark-done` carries `data-session` + `data-todo`; `accept` carries
`data-workspace` + `data-pattern` (the AttributionPattern as escaped JSON). Only the todos and teach blocks
pass the richer `wired` arg; every other caller is unchanged (copy stays positional).

### Contract (append-only, schemas regenerated)
`Action.verb` gains `accept` (the teach APPLY semantics this slice owns). Append-only union. Ran `pnpm
--filter @openinfo/contracts gen`; the 3 affected schemas (`Action`, and `Block`/`Surface` which embed it)
regenerated, the 8 unrelated pre-existing-drift schemas reverted (as in #9–#14).

### Tests + verification
Contracts 67 (unchanged), client 254→259 (all green; the client seam TOCTOU flake cleared on isolated
rerun; engine 486/486 unchanged).
- `hud/action-verbs.test.ts` (NEW — the FIRST driven coverage over `mount.ts`) — two layers: (1) a
  DOM-level test dispatches a click on `mark-done`/`accept`, asserts the injected handler is called with the
  exact payload read off the button, that an inert (payload-less) button never calls the handler, and that a
  REJECTED write paints visible `Failed` text; (2) a SERVED e2e stands up a live throwaway HTTP engine and
  wires the REAL `markTodoDone`/`acceptHintCandidate` through real `fetch` — proving mark-done flips `done`
  on the stored list over the wire (and paints `Done`), accept appends the pattern to the workspace hints
  (creating the doc from a 404), and a `500` on the PUT surfaces as visible `Failed` text, never swallowed.
- `blocks/todos.test.ts` — mark-done renders LIVE (`data-session`/`data-todo`) for an item with a session
  trail and INERT (ghost, no payload) for a hand-added item.
- `blocks/teach.test.ts` — accept renders LIVE carrying `data-workspace` + the exact `data-pattern`; dismiss
  renders visible-but-inert.
- `hud/copy-feedback.test.ts` — updated for the `ActionHandlers` signature; copy still works end to end.

### Out of scope (recorded, NOT built)
A dismissed-candidate suppression store (would make `dismiss` honest). A navigation surface / entity route
(would make `open`/`navigate` honest). `run-mode`/`draft-with` write paths. A `retry`/`flush-now` verb on
the queue block. Seeding these verbs into the SHIPPED template surfaces — the default surface still carries
only `copy`/`open` on relevant-now; the mark-done/accept wiring is exercised by blocks a user composes (the
todos/teach blocks), and pointing the shipped templates at them is a surface-authoring choice, not this
plumbing slice.

## Slice: #55 — render HUD clocks in viewer-local time

BUG FIX. Every wall-clock the HUD showed a human read UTC, not local time — a moment created via the
Try-it card rendered hours off the system clock. `clockLabel` in `client/surfaces/block-renderer/format.ts`
built its compact clock (`2:44p`) from `getUTCHours()`/`getUTCMinutes()`. The doc comment promised "the
live HUD shell can localize later"; that layer was never added, so the one helper leaked UTC to all five
render sites (moments time, distillate window-end, relevant-now why-line + last-seen, the session status
line).

### The seam
`clockLabel(iso, timeZone?)` now formats via `Intl.DateTimeFormat('en-US', { hour:'numeric',
minute:'2-digit', hour12:true, timeZone })` and reassembles the exact compact shape from `formatToParts`
(hour with no leading zero, 2-digit minute, lowercase `a`/`p`, no space/`M`) — output is byte-for-byte what
it was, only the zone changed. `timeZone` is an EXPLICIT optional override: production callers omit it →
viewer-local (the fix); tests pass a fixed zone → deterministic assertions with no `process.env.TZ` games;
a future Settings timezone control (out of scope, as is per-entity timezone display — a recorded design
question) has a ready seam. No caller changed — the five sites stay zone-less/viewer-local. Machine-facing
timestamps are untouched: this helper only ever fed human-read HUD text; contract fields, client log ISO
prefixes, persisted state, and `query.ts` computation params stay ISO/UTC. The engine-served
settings/setup HTML renders only relative durations (elapsed/uptime) — no engine change.

### Tests + verification
Client 259 → 260 (all green), contracts 67, engine 486 — all green in isolation.
- `block-renderer/renderer.test.ts` (NEW seam test) — one fixed instant under two explicit zones renders
  two clocks (`2:44p` UTC vs `10:44a` America/New_York), proving determinism now comes from the parameter,
  not UTC; plus edge shapes (midnight `12:05a`, noon `12:00p`) and the unparseable-stays-empty guard.
- The four integration test files whose full-render assertions round-trip a `clockLabel` string
  (`renderer.test.ts`, `blocks/distillates.test.ts`, `hud/hud.test.ts`) pin `process.env.TZ = 'UTC'` at
  module top so the exercised viewer-local path stays host-stable — the existing expected strings
  (`2:44p`, `2:46p`, `2:30p`, `2:16p · 31m`) are unchanged. Pinning the process zone is the only way to
  keep these end-to-end assertions deterministic without threading a zone through the whole render pipeline
  (which the fix deliberately avoids); the explicit-param seam is what the NEW unit test proves TZ-free.
  (`renderer.test.ts:33/57`'s `2:47p · 31m` is a literal `NowContext.elapsed` fixture, not a `clockLabel`
  output, so it needed no change.)

## Slice: #57 — configurable capture segment cadence (default ~1s)

LATENCY FIX. `SEGMENT_MS = 8_000` in `client/capture/capture-renderer.ts` was the DOMINANT capture
latency: the renderer records audio in fixed-length segments and only ships a segment once it closes, so a
spoken word waited up to 8s (avg 4s) before its audio even left the client — the floor under any real-time
surface, now that STT is ~0.05s/chunk and the LLM lane is unblocked. Made the segment length configurable,
default dropped to 1000ms (~1s).

### The seam
`ShellConfig.segmentMs` joins the existing client-config family in `client/main/config.ts`, resolved by
the SAME precedence as every other shell behaviour — **env > file > default** — reusing the existing
positive-integer resolver `resolveIntervalMs` (a non-positive/garbage value falls back to the default),
so `OPENINFO_SEGMENT_MS` or `"segmentMs"` in `~/.openinfo/client.json`, else 1000. Not a flag document:
it is how the client drives its own recorder; it never touches the engine or its store.

The value reaches the hidden capture renderer by EXTENDING the existing `capture:start` message, not a new
channel. A new `CaptureStartOptions { segmentMs }` (protocol.ts) is the start payload; the main process
injects `{ segmentMs: cfg.segmentMs }` at the ONE seam that knows both the channel constants and the
config — the dispatcher's `send` closure in `shell.ts` — leaving the #41 ack/retry state machine
(`capture-dispatcher.ts`) entirely payload-agnostic. The preload (`capture-preload.cts`) just forwards the
extra arg; its channel strings stay INLINED (a sandboxed preload cannot `require` the ESM protocol
sibling — #41), only `import type { CaptureStartOptions }` crosses. The renderer clamps the passed value
(`resolveSegmentMs`, mirroring the config resolver), records at `c.segmentMs`, and echoes it into each
chunk's `durationMs` (was a hardcoded 8000). A start with no options ⇒ a `DEFAULT_SEGMENT_MS = 1000`
fallback, so the handshake never depends on the payload arriving.

### Segmenting stays stop/restart; the 1s gap analysis (#41 wedge NOT regressed)
Unchanged: segmenting is stop-the-recorder / `new MediaRecorder` / restart, never `timeslice` — the file's
own comment explains why (a timeslice emits fragments of ONE webm stream; only the first carries the
container header, so later fragments are not independently decodable; each segment must be a standalone
webm for `/v1/audio/transcriptions`). Shrinking the segment only makes that boundary MORE FREQUENT; it does
not change the mechanism. The stop→restart is synchronous inside `cycle`'s `onstop` (assemble the finished
blob, ship it, then immediately `cycle()` again which news a fresh recorder), so the only audio not
captured is the sub-frame gap between one recorder's `stop()` and the next's `start()` — inherent to
closing/opening a webm, independent of segment length, and unbounded loss is impossible because a new
recorder is created before control returns. The #41 wedge class (`capture-controller` stopping/pendingStart,
the dispatcher's queued/awaiting-ack) lives one layer UP and is untouched — the renderer change never
alters the start/stop/ack/loaded IPC, only the per-segment timer duration and the durationMs it stamps.

### Per-segment overhead disclosure
Per segment the fixed cost is: one webm/opus container header (~few hundred bytes — Matroska/EBML header +
Opus `CodecPrivate`, order of ~0.3–0.5 KB) plus one `POST /capture/mic` request (chunk.ts base64-encodes
the bytes, +~33%, over the existing spool/EngineLink path). Going 8s→1s multiplies the segment/request rate
8× (≈1/s per active audio source), so the header + request overhead is ~8× what it was — still small in
absolute terms against the audio payload and well within the engine's per-request budget (STT ~0.05s/chunk),
and the point of the change: latency drops from up-to-8s to up-to-1s. Inter-segment audio gap: the
sub-frame stop→restart boundary described above; not separately measurable at this layer and not amplified
in TOTAL by a shorter segment (same boundary mechanism, just more often). The engine already merges chunks
into larger windows downstream, so more, smaller chunks do not change what the engine reasons over.

### Tests + verification
Client 260 → 265 (all green in isolation and in a full-suite run), contracts 67, engine 486 — all green.
- `main/config.test.ts` (+2): `segmentMs` resolves env > file > 1000, clamps `0/-5/nope/''` to the default,
  env beats file, and `parseClientConfigFile` keeps a numeric `segmentMs` / drops a wrong-typed one.
- `capture/capture-renderer.test.ts` (NEW, +3): the renderer is normally not CI-tested (it drives browser
  globals — see its header), so this harness fakes just navigator/MediaRecorder (Blob is Node-native) +
  the `openinfoCapture` bridge and replaces `setTimeout` with a spy that RECORDS the scheduled delay
  instead of waiting. It proves a passed `segmentMs` drives BOTH the stop-timer cadence AND the chunk's
  `durationMs` (250ms → 250, no 8000 anywhere), that a start with no options falls back to 1000, and that
  a non-positive/`NaN` value clamps to 1000.
- KNOWN FLAKE CLASS re-confirmed under parallel load: `client/engine-link/seam.test.ts` (12 vs 11 ordering)
  and one engine test each failed once during a full `pnpm -r test`, then passed 4/4 (seam) and 486/486
  (engine) in isolation — unrelated to this client-only change (nothing here touches engine or engine-link).
## Slice: #58 — transcript fast-path to the HUD + distill cadence decoupling

Two coupled halves. Before this, every visible artifact waited for the full distill pass (LLM, 1.6–3s):
transcribed-but-undistilled text had no path to a surface, and once segments shrink a per-drain distill
would fire an LLM call every couple of seconds — wasteful and still laggy. This adds a live, ephemeral
transcript feed AND throttles the distill LLM pass, so raw words show ~immediately while distilled moments
land on a slower cadence.

### 1 — ephemeral `transcript.updated` (live feed, never persisted)
- **Contract (append-only):** new payload `TranscriptUpdate` (`api/payloads.ts`) `{ sessionId, source,
  text, capturedAtRange:{start,end} }`, and `'transcript.updated' → 'TranscriptUpdate'` added to the
  `Events` map + `EngineEvents`. Only `schemas/TranscriptUpdate.json` was regenerated; the 8 pre-existing
  drift schemas were reverted (untouched by this change).
- **Publish point:** `runTranscribe` in `api/http.ts` (shared by BOTH the legacy drain path and the
  workflow-executor's `transcribe` seam, so both paths emit it). `transcribeChunks` grew an
  `onTranscribed(chunk, text)` hook; the wiring aggregates per (session, source) via the pure
  `buildTranscriptUpdates` and publishes on the bus. `http.ts` rebroadcasts it to WS clients exactly like
  `distillate.updated`/`moment.created`. NOT persisted — durable records still come only from distill; a
  mid-crash loses only the live tail (raw chunks stay durable, re-transcribed next drain).
- **HUD affordance:** `hud/live-transcript.ts` renders a compact rolling strip (last ~45s, oldest fading
  via `.fade`, me/them from the capture split), fed by a client-side buffer the `Hud` fills from
  `transcript.updated`. DEVIATION disclosed in-file: this feed is EVENT-fed (payload rendered directly),
  not query-fed like every other block — so it does NOT go through the query-refresh coalescer (payload
  events re-paint, they do not re-hydrate; that IS the coalescing discipline). The why-line convention does
  not apply — it is honestly labeled "Live transcript · raw, not saved", visually distinct from distilled
  content, with an explainable empty state ("listening…") when a session is live but silent, and NO chrome
  at idle. Buffer resets on session start/end.

### 2 — distill cadence throttle
- **`DistillCadence`** (`distill/cadence.ts`, `DEFAULT_DISTILL_CADENCE_MS = 15_000`) accumulates each
  drain's transcribed chunks per session and releases them to the distiller only when the buffered
  capturedAt SPAN reaches the threshold (there is no `durationMs` on `CaptureChunk` — span is judged from
  capturedAt) OR on a session-end flush. Transcription still runs every drain (it feeds the fast-path);
  only the distill/moments/index LLM pass is throttled. Carry-over is in-memory (disclosed tradeoff).
- **Wiring:** the throttle wraps the `distill` seam on BOTH paths (`distillThrottled`). Session end flushes
  the tail via `flushDistill`, routed through the SAME drain pipeline the throttle wraps (executor
  `runDrain` when `workflow.enabled`, else the legacy distiller call) with a `flushing` bypass so the
  released batch is not re-buffered — this is why the drain acts that ride the distill pass (task-extract)
  run once more over the flushed material before the session-end draft. Session end now always drains +
  flushes when `distill.enabled` (even with no act), so a short session's tail is never stranded.
- **Queue drain-until-empty** (`queue/spool.ts`): the drain now loops until the spool is empty (stopping on
  a failure, to preserve retry-at-idle). Chunks appended mid-drain used to strand until the next external
  trigger; the throttle depends on spooled material ACCUMULATING across drains, so a stranded tail would
  delay distill indefinitely. With this, a multi-chunk capture spanning ≥15s reliably releases a distill
  INLINE on the drain (preserving failure classification + drain acts), and single short sessions flush at
  session end.

### Tests + verification (all green in isolation; full suites green)
- Engine 486 → 493: NEW `distill/cadence.test.ts` (7 — accumulate/release-at-threshold, per-session span,
  flush drains all, `buildTranscriptUpdates` aggregation) + NEW `api/transcript-fastpath.test.ts` (1, a
  createEngineApp e2e: fake stt+llm → `transcript.updated` on the bus AND over a real WS client (served
  proof) → 0 distillates mid-session (throttled, fake llm never called) → session end flushes exactly one).
- The existing drain e2es that asserted per-drain distill were reconciled to the new cadence, NOT weakened:
  multi-chunk ≥15s tests pass UNCHANGED once drain-until-empty lands (distill releases inline mid-session);
  six single-chunk tests were given a second chunk spanning >15s so the drain still releases mid-session as
  they assert (Try-it TYPE/VOICE, tier-zero, model-load, queue-surface, act-off).
- Client 260 → 264: NEW `hud.test.ts` cases render live lines from injected `transcript.updated` events
  (me/them, raw label), expire lines past the ~45s window, show the explainable empty state, and reset on
  session boundaries — all through the real `renderToHtml` path.
- Contracts 67 → 68: `transcriptUpdate.live.json` example validates against `TranscriptUpdate`.
- KNOWN FLAKE CLASS under parallel load: all suites verified green both via `pnpm -r test` and per-file in
  isolation.

## Slice: #7 — per-sense gate chain (name the blocking gate + its fix)

HONESTY EXTENSION. Getting a transcript out of a sense needs SEVERAL independent gates all open (OS
permission, the sense enabled, the engine reachable, an stt/ocr endpoint configured, the processing flag
on, the endpoint healthy). When one is closed the only observable was "no transcript" — the tray reported
the OS-permission layer honestly per sense (issue #41 groundwork) but stopped there. This composes ALL the
gates into ONE named, per-sense verdict: the FIRST closed gate is the blocker, with a one-step fix, so no
sense ever reads as a bare "off" when a specific gate is the cause.

### The split (why two halves compose cleanly)
The chain divides on the process boundary. The CLIENT owns the gates only it can see — sense toggled off
(config), OS/TCC permission, engine reachable, a live session — and the ENGINE owns the gates only it can
see — `distill.enabled`/`distill.transcribe` (audio) or `screen.ocr` (screen), the stt/ocr slot occupancy,
and endpoint health. So the engine evaluates its half and the client chains it AFTER its own; the first
closed gate across the whole ordered chain is the named blocker. No gate logic is duplicated across the
two packages (which cannot share code): each side owns the gates it can honestly answer.

### Engine half (`engine/surfaces/settings/sense-gates.ts`, pure)
- `evaluateSenseGates(input) → SenseGateChain[]` — for each sense (`mic`, `sys-audio`, `screen`, sharing
  the client capture-status sense ids) an ordered `SenseGate[]` with `pass`/`fix`/`detail`, plus the first
  `!pass` gate as `blocking`. Audio chain: `distill.enabled → distill.transcribe → stt slot → stt-health`.
  Screen chain (independent of distill — a frame is read by OCR, not the transcript distiller):
  `screen.ocr → ocr slot → ocr-health`.
- Reuses the EXISTING signals, never re-implements health: flags (GET /flags), the live fabric slots
  (GET /fabric), the queue's classified `lastFailure` (GET /queue), and — when the caller can afford it —
  live `EndpointHealth` from `checkEndpoint`. The health gate closes when a live probe fails OR the drain's
  last classified failure names one of the slot's endpoints (carrying that failure's own `hint` verbatim).
- Pure and I/O-free: health is an INPUT, so every gate combination is asserted headless.

### Surfaced two ways (append-only)
- **`GET /senses`** (`engine/api/http.ts` `getSenses`) — the verdict as JSON for a support flow AND the
  client tray. It runs a LIVE `checkEndpoint` probe of the configured stt/ocr endpoints (the route can
  afford the probe the pure Status render cannot), then composes with flags + fabric + queue lastFailure.
  Added to the `Routes` contract (`SenseGateChain[]`, phase 4).
- **Settings → Status** (`sections/status.ts`) — a "Capture pipeline" card renders each sense's chain with
  the first closed gate highlighted + its fix. PURE render: it uses queue `lastFailure` for the health gate
  (no probe in the render path, matching the section's existing "no new probes" ethos); the live probe
  lives on the route. New CSS `.gate-chain`/`.gate.block` in `settings/assets.ts`.

### Client half (`client/main/capture-status.ts`, pure + `tray-menu.ts`)
- `captureStatuses` now attaches a `blocking: SenseBlock` to each `SenseStatus`, composed in precedence:
  `sense-off → os-permission → engine-unreachable → no-session → <engine gate>`. Unknown client state
  (`engineReachable`/`sessionLive` undefined) is NOT asserted as a block — no false "unreachable" claim.
- The tray submenu names the deeper gate on its own `⚠ blocked: …` line + a `→ <fix>` line; the
  OS-permission gate is NOT re-emitted (the existing header/detail/fix-it already own it, #41 lines intact).
- `EngineSessionClient.senses()` fetches `GET /senses` defensively (404/malformed ⇒ `[]`, so an old engine
  just omits the engine-side gates). `shell.ts` threads `micEnabled`/`systemAudioEnabled`/`connected`/
  `liveState.live` + the fetched verdicts into `captureStatusInput`, refreshing on seed and on the WS
  `flag.changed`/`fabric.changed` events (a flipped flag or a slot edit can open/close an engine gate).

### Tests + verification (all suites green)
- Engine 493 → 508: NEW `sense-gates.test.ts` (11 — precedence per gate, stt/ocr slot, live-health vs
  queue-lastFailure health with the right endpoint, screen's distill-independence) + NEW
  `sections/status.test.ts` (4 — the card renders, names distill.enabled with its fix when all-off, reads
  clear when configured, surfaces a stt lastFailure's hint).
- Client 269 → 279: `capture-status.test.ts` +9 (each gate as the first blocker, precedence, unknown state
  not asserted, sys-audio device gate) + `tray-menu.test.ts` +1 (the blocked line + fix render; the
  os-permission gate is not duplicated).
- Contracts 68 (unchanged count; the `/senses` route row is a `RouteDef`, not a schema example).
- SERVED e2e (driven, not a route test): booted the REAL engine on a temp `OPENINFO_DATA`, drove four
  blocked states over the real HTTP surfaces and asserted `GET /senses` + `GET /settings/status` name the
  correct gate each time — all-off ⇒ `distill.enabled`; distill on / transcribe off ⇒ `distill.transcribe`;
  flags on / empty stt slot ⇒ `stt`; a configured-but-UNREACHABLE stt endpoint ⇒ `stt-health` (via the
  live `checkEndpoint` probe). All four passed; every blocked state surfaced as visible named text.
- KNOWN FLAKE CLASS under parallel load: suites verified green via `pnpm -r test` and per-package.
## Slice: #69 — silence filter (drop no-speech/hallucinated segments before accumulation)

Near-silent capture windows come back from STT as plausible-looking stock phrases (a known failure mode of
speech models on silence — "Thank you.", "Bye.", foreign-language filler), and the distill pass then
narrates them as real conversation — a fictional exchange from an empty room. This drops those segments
BEFORE any text enters the distill accumulator, so silence produces no distillate and no live-strip line.
ENGINE-SIDE ONLY — the optional client-side energy gate the issue also mentions is a separate slice
(another agent's territory) and is NOT in this change; it is the real defense for parakeet-class
hallucinations that survive the segment filter (see the disclosed weakness below).

### The signal (append-only on the canonical transcript)
- `TranscriptSegment.noSpeechProb?: number` (`fabric/stt-adapters.ts`) — the whisper-class per-segment
  no-speech probability (0..1), append-only + optional so a consumer that does not care never sees it. The
  OpenAI/omlx normalizer now lifts each segment's `no_speech_prob` into it.
- The openai/omlx adapters now request **`verbose_json`** (was plain `json`) so the response actually
  CARRIES `no_speech_prob` per segment — plain json returns only `{text}`. The normalizer already tolerated
  the verbose shape (and still tolerates plain `{text}`), so a host that ignores the field degrades to
  no-filtering rather than breaking. whisper-server (`/inference`) is unchanged — it does not emit
  no_speech_prob, and its plain-`{text}` responses fall through the filter untouched.

### The filter (pure, one home)
`dropSilentSegments(result, threshold)` (`stt-adapters.ts`) rebuilds the transcript from the SURVIVING
segments and reports `{ text, dropped, total }`:
- **whisper-class**: a segment with `noSpeechProb >= threshold` is silence → dropped.
- **parakeet-class** (no `noSpeechProb`): the only HONEST per-segment signal is empty/whitespace text, so
  that is all it drops for those flavors. DISCLOSED WEAKNESS: a parakeet hallucination with non-empty text
  is NOT caught here — the real defense there is the out-of-scope client energy gate (never ships the
  window). Duration-coverage heuristics were considered and rejected as speculative without a real
  parakeet fixture to tune against; kept the heuristic honest rather than invented.
- **no segments at all** (plain `{text}`): whole transcript passes through unchanged; pure `''` silence is
  still caught by the caller's existing empty-text check.

### Threshold chosen: 0.8 (default), configurable
`DEFAULT_NO_SPEECH_THRESHOLD = 0.8`. Whisper's own decoder defaults `no_speech_threshold` to 0.6 but only
acts on it in COMBINATION with `avg_logprob`; using `no_speech_prob` as the SOLE gate, 0.6 alone would be
too aggressive, so the bar is raised to 0.8 — the observed hallucination-on-silence failure mode sits well
above 0.9 in practice, comfortably above 0.8, while genuinely quiet speech is spared. Within the issue's
stated 0.6–0.8 range (at the conservative end). Configurable two ways: `TranscribeDeps.noSpeechThreshold`
(per-call), and `OPENINFO_NO_SPEECH_THRESHOLD` (a finite 0..1 env override, resolved once at wiring time in
`api/http.ts`) — tunable without a rebuild, no settings-surface change.

### Where it filters + accounting
`transcribeChunks` (`distill/transcribe.ts`) applies the filter right after `invoke`, on the boundary into
the accumulator:
- A window filtered to nothing contributes NOTHING — no text chunk (so nothing distills) and NO
  `onTranscribed` call (so a hallucination never reaches the `transcript.updated` live strip, the whole
  point). An empty `''` transcript keeps the existing silence log; a filtered-to-nothing one logs as
  skipped-as-silence.
- Partial filtering (a hallucinated tail dropped, real speech kept) emits only the surviving text.
- ACCOUNTING: a new `onSilenceSkipped(chunk, { dropped, total, windowSkipped })` deps hook (mirroring the
  #58 `onTranscribed` idiom — a callback, no return-type change to ripple through the executor seam). The
  `api/http.ts` wiring aggregates it per drain into a log line: dropped-segment count + skipped-window
  count. DEVIATION (disclosed per the issue): the counter is a **log line + the callback's returned
  metadata**, NOT a QueueStatus field — QueueStatus was deliberately not redesigned for this slice; a
  natural place to surface it can be added when the queue-status shape is next revisited.

### Tests + verification (all green in isolation; full suites green)
- Engine 493 → 505 (+12).
  - `fabric/stt-adapters.test.ts` (+8): openai adapter lifts per-segment `no_speech_prob` from a
    verbose_json body; openai/omlx request `verbose_json`; `dropSilentSegments` drops at/above threshold and
    rebuilds the transcript, an all-silence window rebuilds to `''` (counts every drop), the threshold
    boundary (`== 0.8` drops, just-below keeps), threshold configurability (0.6 vs 0.9 flip a 0.7 segment),
    parakeet-class whitespace-only drop, and plain-`{text}` passthrough.
  - `distill/transcribe.test.ts` (+4): a silent fixture (all segments no-speech) → zero accumulated chunks,
    zero `onTranscribed` events, one skipped-as-silence accounting record; a speech fixture (low
    no_speech_prob) is UNAFFECTED; partial filter keeps the speech and drops the tail (windowSkipped:false);
    threshold configurability (0.6 drops / 0.9 keeps the same 0.7 fixture).
  - The existing STT e2e/adapter tests are unchanged — the fake stt servers return plain `{text}`, which
    passes the filter untouched, and `stt.test.ts`'s `response_format` assertion (`/json/`) still matches
    `verbose_json`.
- Full `pnpm -r test`: contracts 68, client 269, engine 505, workbench (no tests) — all green. The KNOWN
  FLAKE CLASS (fabric scan port-probe ECONNRESET / timing) did not surface this run.

### Incidental cleanup (disclosed): a stray NUL made transcribe.ts a binary blob
`buildTranscriptUpdates` (#58) keyed its per-(session,source) group Map with a LITERAL NUL byte delimiter
(`` `${sessionId}\x00${source}` ``), which had been committed as a raw `0x00` in the source. That single
byte made git classify the whole file as BINARY (`Bin` in `--stat`, `Binary files differ`) — so this
slice's transcribe.ts changes would not render as a reviewable diff. Replaced the raw byte with the `\u0000`
ESCAPE in source: byte-identical runtime key (still a NUL-delimited group key, zero behavior change), but
the file is now valid UTF-8 text and diffs render. Verified: the #58 transcript-fastpath grouping test
still passes unchanged.

## Slice: #70 — freshness-first drain + age-shed policy

The drain processed spool files oldest-first (a plain sessionId name-sort). After any stall — endpoint
outage, cold start, a config gap — a live session waited BEHIND the backlog: the surface rendered the
past (replaying dead air) while fresh speech queued. Real-time UX inverts the priority — the newest
material should process first; the backlog backfills at idle or is shed by an age policy. This makes the
drain freshness-aware and adds a bounded-staleness safety valve, composing with the #58 drain-until-empty
loop and the failure re-queue without touching either's contract.

### Ordering: newest-first while live, oldest-first at idle (`queue/spool.ts`)
- The prior `readdir().sort()` (alphabetical by sessionId) is replaced by `orderedPending()`: stat each
  pending `.jsonl` for its `mtimeMs` and return them OLDEST-first (ties break on name for determinism). fs
  mtime is the cheap honest freshness signal — `append()` writes to the live session's own file, so its
  mtime advances with each capture, while a stalled backlog file keeps its old mtime. A file that vanishes
  mid-stat (a race with a concurrent rename) is skipped this pass and re-read next — same tolerance as the
  existing rename guard.
- A new READ-ONLY `SessionLiveProbe = () => boolean` seam (injected from `api/http.ts`, closing over
  `store.liveSession('default')`) governs ORDER only: LIVE ⇒ the pass reverses to newest-first (render the
  present); IDLE ⇒ oldest-first (FIFO the backlog while nothing new arrives). The queue keeps ZERO store
  imports — the describeFailure/overflow DI precedent. Absent probe ⇒ idle default, loses nothing. Order is
  recomputed each pass, so a session going live mid-drain flips it and a re-queued file's freshness re-reads.

### Age-shed policy: drop stale backlog, never silently (`queue/spool.ts`)
- Before processing each file, if `now - mtimeMs >= maxAgeMs` the file is SHED: dropped, not processed,
  never re-queued — that is the whole point, a live session must not wait behind (or replay) quarter-hour-
  old dead air. Horizon = `DEFAULT_MAX_AGE_MINUTES` (10m), overridable at wiring time via
  `OPENINFO_QUEUE_MAX_AGE_MINUTES` (a finite >= 0 value; **0 disables shedding entirely**), resolved once in
  `api/http.ts` exactly like #69's `OPENINFO_NO_SPEECH_THRESHOLD` — tunable without a rebuild.
- Shedding claims the file under a non-`.jsonl` name (`<file>.shed`) FIRST, then unlinks — so even if the
  unlink fails, the drain-until-empty re-read cannot see the file again and spin. Composes with the loop:
  shed files leave the glob, sawFailure still stops the loop, a fresh file that FAILS still re-queues (its
  mtime preserved) and only sheds once it later ages past the bar (bounded staleness, not silent loss).
- ACCOUNTING (never a silent deletion): every shed file's age is collected across the whole drain and
  emitted as ONE audit log line on the way out — `queue age-shed (#70): dropped N stale file(s) beyond Nm —
  age <newest>..<oldest>` — plus an in-memory `shedFiles` counter surfaced additively on `QueueStatus`
  (`shared/contracts` payloads), present once > 0 (absent = nothing ever shed), distinct from `drainedFiles`
  and from a re-queue. This is the "drain-stats shape accommodates it cheaply" counter the issue invited.

### Composition with #58 (drain-until-empty) and the failure re-queue
Freshness governs ORDER; the #58 cadence throttle still governs LLM SPEND (unchanged). The re-queue path is
byte-for-byte as before for fresh files. The only new interaction: a file aged past the horizon sheds
instead of re-queuing — so a persistently failing STALE file can no longer pin the backlog indefinitely.

### Tests + verification
- Engine 508 → 525 (+5 in `queue/spool.test.ts`, +12 elsewhere already present): ordering under LIVE
  (newest-first) vs IDLE (oldest-first) with three back-dated fixture files; age-shed drops beyond the
  horizon + keeps fresh + counts (asserts the audit log line names count + age range); the shed boundary
  (just-under kept, well-over shed); shed-vs-requeue (a stale file sheds/not-requeued WHILE a fresh file
  that throws re-queues and records lastFailure in the same pass); `shedFiles` absent until something sheds.
  Fixtures back-date `mtime` via `utimes` — mtime IS the signal the drain reads, so the fixture is honest.
- Contracts 68 (unchanged count — the additive `shedFiles` optional integer round-trips the schema test).
- Suites: engine isolated 525/525 green (a first `pnpm -r` run flaked the profile-activation e2e with
  `fetch failed`/ETIMEDOUT — the known port-probe/network flake class — green on isolated re-run). Full
  `pnpm -r test`: contracts 68, engine 525, workbench (no tests); client oscillated 278/279 across runs
  (the known client-seam/timing flake class — ZERO client files touched this slice), 279/279 on re-run.

### Deviations / judgment calls (disclosed)
- The `shedFiles` counter is a NEW optional field on `QueueStatus` (`shared/contracts`), a step outside the
  literal `queue/*` + `http.ts` territory but the cheap additive accommodation the issue explicitly invited
  ("if the drain-stats shape already accommodates it cheaply, a counter"). #69 deferred touching QueueStatus;
  this is that natural revisit. No surface renders it (surfaces/client are off-limits this slice) — it rides
  the existing `GET /queue` serialization; the log line is the always-on accounting.
- Freshness uses fs mtime, not a parsed max `capturedAt` — mtime is O(1) per file (no read/parse), advances
  on every append, and needs no chunk-shape assumption. A clock-skew or touched-file edge is acceptable for
  an ordering/staleness heuristic; the never-silent accounting means any mis-shed is visible.
- Shedding is UNCONDITIONAL on age (not gated on live), so a stale backlog is bounded even during a long
  idle stall; default 10m means a brief blip still backfills normally. Set `OPENINFO_QUEUE_MAX_AGE_MINUTES=0`
  to restore strict never-lose-capture (no shedding) if a deployment needs it.
