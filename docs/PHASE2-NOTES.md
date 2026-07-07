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

## Slice: Index v0 (entities riding the distill pass, single workspace)

### Where it lives — extraction in `index/extract.ts`, wiring in the distiller
CODE_MAP homes the context index under `engine/index/` ("extract · rank"), so the entity extractor,
the ranking function, and the relevant-now join live there — unlike moments, which CODE_MAP homed
under `distill/`. The extractor follows the moments shape exactly: store-free and bus-free (pure
given injected `invoke` + template), unit-testable against canned llm output; the *distiller* owns
the per-window call, the store upsert, and `entity.updated` publishing, because entity extraction
has no independent trigger — it rides the same merge windows. The defensive-JSON policy moved to a
shared `distill/parse.ts` (used by both extractors) rather than being copied.

### Call count — chosen: a THIRD tight call per window
Same reasoning that won for moments, applied again and re-weighed:
- Entities are a simpler output grammar than moments, so piggybacking on the moments call was
  tempting — but it would put two output grammars in one response, which is exactly the 3–8B
  failure mode slice 2 documented, and a malformed combined response would cost the *moments* too.
- Cost asymmetry: piggybacking would also couple the flags (entities would require distill.moments);
  as a third call, `distill.index` works with moments off (you just get no refs links).
- The calls run on the drain (idle path), outside any latency budget. Three tight jobs per window
  is the cheap side of the trade on today's hardware; same revisit trigger as slice 2 — if drains
  back up on real hardware, collapse extract calls first.
The entity prompt is the seeded, versioned `tpl-entities-default` (kind `extract` — the existing
kind covers the extraction *stage*; a new kind would have forced a schema enum change for no
behavioral difference, templates are distinguished by id). It receives the window `{{transcript}}`
and the just-produced `{{summary}}`, with voice interpolation like its siblings.

### Entity resolution — upsert by (kind, normalized name), store-owned
`store.upsertEntity` is the only write path (DB-handle hard rule). Match policy v0: same `kind`
AND normalized mention name (trim/lowercase/collapse-whitespace) equals the record's normalized
name **or any normalized alias**. On match: `mentions` +1, `lastSeen` advanced, new surface names
unioned into `aliases`, a provenance entry appended (distillateId, window bounds, endpoint/model —
one per mentioning window, so every entity carries its full inspectable trail), moment refs
unioned. On miss: new record, id + firstSeen store-stamped. The merged record is TypeBox-validated
before write, mirroring the moment policy. Known weaknesses, accepted for v0:
- No fuzzy matching: "Dana C." vs "Dana Cruz" are two records until the model emits one as an
  alias of the other (the prompt asks it to merge obvious aliases).
- Same name, different referent collides ("Mercury" the project vs "Mercury" the vendor — same
  kind, one record). Canon/reference-merging (P3) is the designed fix; name-normalized matching is
  the documented thin-index trade from the risk register.
- Cross-kind duplicates are intentional (a person and a topic named "Dana" are distinct).
- The linear per-kind scan in `findEntity` is O(entities-per-kind) per upsert — fine at
  single-workspace v0 scale; an alias index table is the obvious upgrade when it isn't.

### Moment.refs linking — same-pass, post-hoc name matching
Moments extracted in a window are HELD until that window's entities resolve; a moment's `refs`
gains the entity id when the moment **text** mentions the entity's name or an alias at a word
boundary (case-insensitive, `entityMentioned`). Both directions are written: `Moment.refs` →
entity ids, `Entity.momentRefs` → moment ids. Then the moment is persisted and published — so
`moment.created` always carries final refs and no persisted record is ever rewritten. Limits, by
design: **same-pass linking only** (moments from prior sessions/passes are never retro-linked —
that is a recall/canon concern, not an extraction concern); no pronoun/coreference resolution
("she'll send it" links nothing); `speaker` labels are not matched against person entities
(diarization/identity is P7 per CODE_MAP).

### Ranking — recency×frequency, constants in code (deliberately)
`index/rank.ts`, pure: `score = (1 + log2(mentions)) × 0.5^(ageHours / halfLifeHours)`, default
half-life 4h. Frequency is log-damped so a runaway topic cannot drown the list; recency is
exponential half-life decay on `lastSeen`. Ties break lastSeen-desc then name-asc (deterministic).
These are the first two factors of the ARCHITECTURE §5 formula; `match(live stream)` and
`person-affinity` need the live stream and person identity (later phases). The knobs are exported
constants + a per-call config override, NOT a versioned config document yet — a deliberate,
documented exception to "everything user-configurable is a document": nothing user-facing reads or
tunes ranking in v0, and the HUD relevant-now *block document* (`join(live, index).top(4)`) is the
natural home for user-tunable ranking when it lands. Revisit when the HUD surface slice starts.

### Relevant-now join + API
`index/relevant.ts::relevantNow` answers "which entities matter right now": rank the workspace's
entities, join each with the recent moments referencing it (via the refs written above, most
recent first, capped) — so a noisy entity is inspectable down to the moments and provenance that
put it there. `?session=` narrows to entities referenced by that session's moments and joins only
those. Served as `GET /relevant` (`RelevantEntity[]`, a new payload contract) plus a plain
`GET /entities`, both mirroring the /moments route pattern (unknown workspace ⇒ `[]`).

### Contracts
- `Entity` gains OPTIONAL `mentions` and `provenance[]` — additive; the Phase-0 shape (momentRefs,
  outboundCount, canonicalOf, pinId, firstSeen/lastSeen) is untouched. `outboundCount` stays 0 and
  `canonicalOf`/`pinId` stay unset until canon/pins (P3).
- `RelevantEntity` payload (entity + score + joined moments); `GET /entities` + `GET /relevant`
  routes (phase 2). `entity.updated` in the Events contract already carried `Entity` — correct as
  written, no placeholder fix needed this time; it is now actually published per upsert.
- Flag `distill.index` (OFF, scope engine). Requires `distill.enabled` (the drain returns before
  the distiller runs otherwise). Does NOT require `distill.moments`: entities index fine alone,
  but Moment.refs linking only happens when both extras are on (no same-pass moments to link
  otherwise). All three flags read per-drain; API flips take effect without restart.

### Deferred (out of this slice, by scope)
- Canon (reference-merging, outbound-use weighting), pins/ingestion, cross-workspace entity graph,
  embeddings/vector search — P3 per IMPLEMENTATION.
- Retro-linking refs on previously persisted moments; speaker→person entity matching.
- `match(live stream)` and `person-affinity` ranking factors; a ranking config document (see above).
- Retry-at-idle llm.smart upgrades — still deferred from slice 2; a drain failure re-runs the same pass.

## Slice: Sessions lifecycle (manual start/stop)

### Contracts
- `POST /sessions` now takes a dedicated **`StartSessionRequest`** payload (workspaceId + modeId
  required; registerId + title optional), NOT a partial/full `Session`. The caller supplies only
  what it knows; the engine stamps id/startedAt/attribution and returns the full Session. This
  mirrors slice 3's `RelevantEntity` precedent (a purpose-built payload, not an overloaded record) —
  a caller should never invent server-owned fields, and "POST a Session, get a Session back" would
  have forced it to fabricate an id and a `manual` attribution it has no business authoring.
- End route added: **`POST /sessions/:id/end`** (no request body; `endedAt` is server-stamped
  `now()`), following the existing `POST /sessions/:id/reroute` sub-resource verb pattern rather
  than a `PATCH`. Ending is a lifecycle transition, not a partial edit — a verb sub-resource reads
  truer and leaves `PATCH /sessions/:id` free for a future generic edit if one is ever needed.
- `Session` is used **as-is** from Phase 0 — no schema change. Seeded `session.live.json` +
  `startSessionRequest.start.json` examples (validated by contracts.test).
- Events: `session.started` / `session.ended` (both already carrying `Session` in the P0 contract)
  are now actually published + WS-broadcast, exactly like `moment.created` et al. `EngineEvents`
  gained the two keys.

### Concurrency policy — ONE live session per WORKSPACE; start-while-live AUTO-ENDS
- Scope is **per workspace**, not global: DB-per-workspace isolation exists precisely so parallel
  workspaces run independently, so each workspace may hold one live (unended) session at a time and
  they don't interfere. `store.liveSession(workspaceId)` is the single unended session.
- On **start-while-live** in the same workspace we **auto-end** the live session (stamp `endedAt`,
  emit `session.ended`) and then start the new one (emit `session.started`) — a 200, not a 409.
  Rejecting would strand a forgotten-to-stop session and make the client babysit lifecycle; the
  HUD's Now line wants "start B" to just work.
- **`session.switched` is NOT emitted by this slice.** That event is router territory (P3): it
  denotes a *detected* context switch (with reroute semantics), which a manual start is not. A
  manual start-while-live is honestly two discrete lifecycle events (A ended, then B started), so
  we emit exactly those two. `session.switched` stays genuinely unused until the router lands —
  better an honest silence than a fabricated switch event a P3 consumer would misread.
- End is **idempotent**: ending an already-ended session returns it unchanged and emits no second
  `session.ended`; an unknown id is 404. The end route looks the session up **across workspaces**
  (`store.findSession` — ids are uuids, globally unique) since `/sessions/:id/end` addresses it
  without a workspace.

### Closing the distill loop — real session records now steer voice + windowing
The distiller previously resolved *every* chunk against the default meeting mode (`docs.mode()`)
and that mode's `registerId` as the mode-scope default binding. It now, per session group:
1. Looks up the real session record via `store.getSession(chunkWorkspaceId, sessionId)`.
2. If found, uses **that session's `modeId`** to load the mode document (so merge window +
   token budget come from the session's mode) and adds a **session-scope binding** from the
   session's `registerId`. Because resolution precedence is session > workspace > mode > global,
   the session register wins over the mode default — this is what makes "the same meeting run under
   a different register produces visibly different output" (the Phase-2 exit criterion) true. The
   e2e test proves it: the same transcript resolves sales-floor (charm 8 / specificity 5) under a
   session record vs boardroom (charm 2 / specificity 9) on the fallback, echoed in the prompt.
3. **Fallback (unchanged behavior): no session record ⇒ the default meeting mode**, because capture
   can (and does) spool before or without a started session — the drain must never block on a
   session existing. A session whose `modeId` points to a missing mode document also falls back to
   the default mode doc (via `docs.mode(id)`'s existing fallback). Stored voice bindings still come
   first, so an explicit stored binding out-ranks both synthesized (session/mode) bindings.

### Store — sessions live in their workspace's own DB
`store.saveSession/getSession/listSessions/liveSession/findSession` are the only path that touches
sessions (DB-handle hard rule). The per-workspace `sessions` table (present since Phase 1 as
`(id, body)`) gained `started_at` + `ended_at` columns — lifted out of the JSON body only to drive
ordering (newest-started first) and the `live` filter (`ended_at IS NULL`); the full record stays
in `body`. `saveSession` is insert-or-replace (start writes, end re-writes with `endedAt`), workspace
created on demand like `saveDistillate`/`saveMoment`.

### No flag — deliberately (flags gate behavior, sessions are lifecycle records)
Sessions get **no flag**. The flag philosophy here is that flags gate *behavior* and documents
*configure* it; a session is neither — it is a lifecycle record plus its CRUD routes, exactly like
`/workspaces` (ungated). Everything a session could switch on is *already* gated: the distiller only
runs behind `distill.enabled`, and a real session record merely feeds that existing pass better
inputs (its own mode/register) rather than turning on any new code path. A `sessions.enabled` flag
would gate nothing that isn't already gated and would only add a way to half-break the coming HUD
(which is a hard prerequisite on live sessions). Consistent with the existing flags, which all gate
an optional *processing* behavior (capture.sim, fabric.http, distill.*), never a resource's routes.

### Client engine-link
Thin typed methods added, matching the established get/getArray/request idiom (client never opens a
DB, only talks to the API): `sessions({ workspace?, live? })`, `startSession(StartSessionRequest)`,
`endSession(id)`. These are what the HUD slice will call for its Now line and start/stop control.

### Deferred (out of this slice, by scope)
- Router / context-switch detection / attribution beyond the single `manual` evidence entry, and
  `POST /sessions/:id/reroute` (route exists in the P3 contract, left unimplemented) — all P3.
- `session.switched` emission (router) — see policy above.
- HUD surface / blocks / rendering (next slice); follow-up draft (Act); calendar capture.

## Slice: HUD surface (the first UI) — document-driven block rendering

### Contracts — one addition (`QueryResult`), no shape changes
- `QueryResult` (api/payloads.ts): the body of `POST /query`. `{ source, items: unknown[], top?,
  truncated }`. `items` is `unknown[]` keyed by `source` (relevant-now→RelevantEntity, moments→
  Moment, sessions→Session, entities→Entity, ledger→Commitment, pins→Pin) rather than one over-broad
  union — the surface source already discriminates, and a union array would make Value.Check try every
  member per row. `truncated` reports "more existed than returned" (the HUD shows top-K, the workbench
  holds the rest — surface.ts). Seeded `queryResult.relevant.json`, validated by contracts.test.
- Everything else this slice needs was ALREADY in the Phase-0 contract: `Surface`/`Block`/`BlockQuery`/
  `Action`, the routes `GET/PUT /layouts/surfaces/:id` + `POST /query`, and the events. Used as-is.

### Query-execution shape — chosen: BOTH a layout endpoint AND a query endpoint (hydration), because the contract already names both
The Routes contract names `GET /layouts/surfaces/:id` (→ Surface) *and* `POST /query` (BlockQuery →
QueryResult) at phase 2 — so the intended shape is not "surface endpoint hydrates every block inline"
but **serve the static layout document, then hydrate each block's query separately**. That is exactly
right for this product: "the client never owned data — every built-in block is already an API call"
(hud-v2.html), and a surface document changes rarely while its blocks re-hydrate constantly on live
events. Inlining hydration into the surface GET would recompute the whole layout on every moment and
couple caching of the (stable) layout to the (volatile) data. So the HUD does `GET /layouts/surfaces/:id`
once and `POST /query` per block, re-issuing only the queries on live events.

### Surface documents — versioned layout docs in `_meta.db`, served/saved by `engine/surfaces/`
- Surfaces are versioned, cloneable documents like everything user-configurable. `SurfaceDocuments`
  (engine/surfaces/documents.ts) mirrors `DistillDocuments`/`VoiceDocuments`: LayoutStore kind
  `surface`, seeds the shipped openinfo HUD only when absent (never clobbers a user edit), and `save`
  stamps `version = latestStored + 1` (LayoutStore keeps every prior version — cloneable history).
- **Home: `engine/surfaces/` gains a P2 role.** CODE_MAP homed surfaces/ at P4 (serve workbench) +
  P6 (custom-block sandbox), and "layouts (P2)" under store/. The layout *documents* do live in the
  store (LayoutStore); the *serving + query compilation* logic is the surface module's concern, so
  `surfaces/{documents,query,defaults}.ts` is its P2 down-payment. Noted in CODE_MAP.
- **The block-query compiler** (engine/surfaces/query.ts) realizes the Phase-0 decision "compiled
  server-side to store calls": relevant-now/moments/sessions/entities hydrate through store/ (the
  DB-handle rule); **ledger (P4) and pins (P3) return `[]` with documented semantics, not an error**,
  so a HUD composing a not-yet-backed block shows an empty explainable block instead of failing.
  `session: "current"` binds to the workspace's live session AT QUERY TIME — the layout stays
  context-agnostic and the same document works across sessions. `top` bounds rows; `truncated`
  compares against a capped superset (≤50, the BlockQuery.top max).

### No flag — deliberately (consistent with the sessions slice)
Serving/saving a layout document and compiling a read query are **resource routes, not gated
behaviors** — exactly the sessions-slice reasoning. The data a HUD block shows is *already* gated
upstream (moments/entities only exist behind `distill.*`); a HUD that renders an empty relevant-now
block when distill is off is the honest state, not a half-broken feature. A `hud.enabled` flag would
gate nothing that isn't already gated.

### The renderer — pure VNode tree, `render(surfaceDocument)`, no hardcoded layout
- `client/surfaces/block-renderer/` outputs a **pure virtual-node tree** (`document + hydrated data →
  VNode`), serialized to HTML by `renderToHtml`. This mirrors the engine's pure-function/imperative-
  shell split (rendering is pure and node-testable; `mount.ts` is the DOM shell) and — decisively —
  lets the renderer be unit-tested with `node:test` asserting real serialized markup **without adding
  jsdom** (the client had no DOM test lib, and its package depends only on contracts). `renderSurface`
  walks the document stack, applies `show`/`collapsed`/`top`, and dispatches by `BlockTypeName` through
  a registry — it contains ZERO block-type-specific branching, so two different documents produce two
  different layouts (a renderer test asserts exactly this). `custom` doubles as the fallback for any
  block type a client build lacks (append-only BlockTypeName), so a forward document degrades instead
  of breaking. The render is recognizably design/renderings/hud-v2.html: ● commitment / ◆ question /
  ▲ decision / ✱ artifact moment glyphs (◉ person on relevant-now rows), the context line + heartbeat,
  the Now line, per-row why-lines built from real index data, the moments stream, `.mini` actions.
- **Consciously simplified vs hud-v2**: the absolute-positioned moment **tick-rail** (needs
  whole-session geometry) is omitted; the `compact` panel variant is not auto-selected; provenance is
  surfaced as the one-line why (mentions + latest moment), not a hover card. States B/C of the mockup
  (router re-keying, the evidence-checked ledger) depend on P3/P4 stores and are out of scope.

### Live updates — chosen: RE-QUERY, not patch-in-place
On a relevant WS event (`moment.created`, `entity.updated`, `distillate.updated`, `session.started`,
`session.ended`) the HUD re-issues the affected block queries and re-renders; a session event also
re-derives the Now line. Patch-in-place was rejected: the block query is the single source of truth and
the engine owns ranking/joining — reproducing that client-side to splice one row in would duplicate the
intelligence and violate "the engine thinks, the block renders". Rapid events are coalesced into one
trailing refresh. The surface document is fetched once (not re-GET on data events).

### Actions — `copy` is live, the rest are visible-but-inert (documented)
Buttons render from the seeded document's `Action` verbs. `copy` is wired through an injected,
clipboard-safe `copy(text)` (browser `navigator.clipboard`, overridable for Electron/tests); the button
carries the ready text as `data-copy` and one delegated listener (survives re-render) fires it. Every
other verb (open/mark-done/dismiss/run-mode/draft-with/navigate) renders visible-but-inert: the dismiss/
teach write path doesn't exist (slice 2), navigation has no workbench target yet (P4), and "verbs never
send/commit outward" (Action's own contract) — so wiring them now would be theater.

### Where the HUD mounts today — a browser dev entry (Phase 1 left no Electron window)
PHASE1-NOTES: "no Electron code was added in Phase 1" — the seam was proven headless. So the HUD mounts
via `client/surfaces/hud/dev-entry.ts` + `apps/client/dev-hud.html`: serve `apps/client` statically and
open `dev-hud.html?engine=…` against a running engine. The controller depends on a narrow browser-safe
`HudTransport` (surface/query/sessions/subscribe) — NOT `EngineLink` directly, because EngineLink pulls
in `node:fs` for its offline capture spool and can't load in a plain browser. EngineLink gained the same
four methods and satisfies HudTransport **structurally**, so the Electron client passes an EngineLink;
the dev entry passes a fetch+WebSocket transport. **Remaining to wire (small follow-up):** a real
content-protected Electron window (client/main is still a Phase-1 scaffold) hosting the same mountable
`Hud` — no renderer/controller change, just the window + an EngineLink instance.

### DOM typing — kept out of the node-typed package
`mount.ts` and `dev-entry.ts` touch `document`/`navigator` but the client tsconfig is `types: ["node"]`;
adding the DOM lib would collide with @types/node's `fetch`/`WebSocket` globals. They are typed against
minimal **structural** interfaces (the exact DOM subset used) reached via a single `globalThis` cast, so
the package stays node-typed and conflict-free while the real type safety lives in the pure renderer.

### Templates — #1 and #3 shipped as pure documents (nearly-free, as predicted)
`templates/openinfo-hud/surface.json` (identical to the engine-seeded default) and
`templates/glass-minimal/surface.json` (Now line + a collapsed moments stream). Two documents, two
layouts from one renderer — the openness proof. They reference the builtin `mode-meeting`/registers by
id rather than re-declaring them (a template adds its own mode/registers/flags only to diverge). Glass
Minimal's interactive capture pill (mic/screen toggle buttons) is palette territory (P6); it ships now
as the minimal readout surface.

### Deferred (out of this slice, by scope)
- Follow-up draft / the Act node (final Phase-2 slice); surface/mode/dial editors + palette + custom-
  block sandbox (P6); the workbench app (P4).
- Ledger/pins backing stores (P3/P4) — the `ledger`/`pinned-doc`/`hint` block renderers exist and the
  compiler returns `[]` for their sources, so they light up when the stores land, no new home invented.
- The `hud-v2` tick-rail, auto-compact density, hover provenance cards; states B/C (router re-key,
  evidence-checked ledger).
- Electron window wiring (see above); user-tunable relevant-now ranking as a block-document knob
  (slice 3 named this the home) — the block carries `top` today; exposing rank constants as query
  params is the P6 editor's job.
