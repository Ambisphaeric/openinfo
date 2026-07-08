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

## PHASEB — screen capture + OCR/VLM invocation  *(P4B, Terminal B, branch `p4b-screen-ocr`)*

The founder's flagship use case (OSS-contribution screen watching) and the least-built element: OCR/VLM
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
- **Workflow-step integration** — `ocr`/`vlm` are homed in the `WorkflowStepKind` union (P4A slice 1) but
  the screen processor rides capture ingest directly today; folding screen understanding into the workflow
  executor as an `ocr`/`vlm` step is the small JOINT slice after P4A's executor and this both land.
- **`capture.received` payload slimming** — `http.ts` rebroadcasts the FULL CaptureChunk (incl. the base64
  image) over the event feed; slimming that is an http.ts-owned (P4A) concern, not this branch's.
- **A distillates read route / `/query` distillates source** — screen distillates currently surface only
  via `distillate.updated` + the workspace DB; a first-class read surface is unscoped here.
