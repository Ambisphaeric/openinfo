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

## Slice: Follow-up draft — the first Act node (act/, act.enabled) — CLOSES PHASE 2

### DAG vs direct — chosen: DIRECT (the recipe executor is NOT transplanted this slice)
`workflow/` was a design placeholder (README only); no P2 slice ran through a DAG — distill/moments/
index ride the drain, sessions/HUD are wired at their routes. The "first Act node" language invited
transplanting loom's recipe executor now; it was declined. A DAG executor for a **single, unchained,
one-node graph** is ceremony: the follow-up draft has one trigger (session end) and no downstream
node, so a compile-mode-to-DAG layer would add an indirection every reader traces through and buy
nothing this phase uses. The five primitives are already named and homed (`distill/`, `index/`,
`voice/`, `act/`, `route/`), so the eventual executor will **compose** these modules, not absorb them
— declining now creates no rework debt. **What forces the transplant later:** a mode needing more
than one act, or chained nodes (an act consuming another's output), or per-mode act ordering/fan-out.
At that point `compile.ts` turns `Mode.acts` (+ source/distill/overlay config) into a DAG and these
direct triggers become node invocations. `workflow/README.md` now records exactly this.

### Home — a new `act/` module (the Act primitive's home), NOT `ledger/prepare`
The Act primitive gets its own top-level engine module, mirroring how `distill/`/`index/`/`voice/`
each own a primitive. CODE_MAP had no `act/` row (only `ledger/ … prepare (action cards)` at P4);
per CODE_MAP rule 5 a homeless feature needs a note before code — so `act/` is added to CODE_MAP.
Distinct from `ledger/prepare`: that (P4) attaches prepared **action cards to ledger commitments**;
the follow-up draft is the Act primitive's canonical session-end artifact and its foundation.
`ledger/prepare` will build on `act/` in P4. `act/`: `draft.ts` (the pure `composeFollowUpDraft` +
the `Actor` orchestrator), `defaults.ts` (the seeded template), `documents.ts` (`ActDocuments`).

### Trigger + the ≤60s story — on `session.ended`, flush the drain, then compose
The act rides **session end**, not the chunk drain (its input is already-distilled records, not raw
chunks — the drain processor's signature is `chunks ⇒ void`, a poor fit; and it fires once per end,
not per chunk). The http.ts bus subscriber, gated on `act.enabled`, does: `await queue.drainNow(log)`
then `actor.runFollowUpDraft(session)`. **`drainNow` (new)** waits out any in-flight scheduled drain
then runs one guarded pass, so every pending chunk for the session is distilled *before* the draft is
composed — the draft reflects the whole meeting, resolving the in-flight-distillation concern. ≤60s:
the draft is built from stored distillates/moments (NO re-run of the llm over raw transcript) plus one
prose llm call, so on idle local hardware a drain-flush + one call is well under budget. The mode's
`acts[].params.latencySecPostSession: 60` documents the *intent*; we do not hard-cut on a timer (that
would truncate a legitimately slow drain) — the e2e asserts the draft lands < 60s and logs elapsed.
Auto-end (start-while-live) also emits `session.ended`, so an auto-ended session is drafted too; the
end route is idempotent, so a re-end emits no second event and drafts nothing twice.

### Retry — honest deviation from the drain's retry-at-idle
Because the trigger is a one-shot lifecycle event (not a durable queue file), a failed draft does NOT
get the drain's re-queue-at-idle. Mitigations in place: `invokeLlm` already fails over across llm
endpoints, and `composeFollowUpDraft` bounded-retries a blank completion (default 2, mirroring the
moments extractor). A transport failure logs and prepares no draft that session. **Gap (documented):**
no durable cross-restart retry for the act; the future home is either a manual re-compose route
(`POST /sessions/:id/draft`) or folding the act into the DAG executor with a durable job. Called out
because the drain-job approach *would* give retry-for-free — it was weighed and rejected on ordering
fragility (a draft job file must sort strictly after all chunk files, and within one drain pass the
chunk files must process first; `drainNow` on a lifecycle event is deterministic where that is not).

### The draft record + provenance
`Draft` (records/draft.ts, `DRAFT_SCHEMA_VERSION = 1`): id, sessionId, workspaceId, `actKind`
(union mirroring `Mode.acts[].kind`; only follow-up-draft implemented), `body` (markdown prose),
`status` (a **single-member enum `'prepared'`** — the type itself codifies "the app prepares, never
sends"), `voice` (registerId?/scope/dials — same shape as Distillate, the vector that shaped it), and
`provenance` (templateId + templateVersion, slot/endpoint/model, and the exact `sourceDistillates`/
`sourceMoments` ids). Every draft is inspectable back to what it was built from (product principle 1).
`draft.created` event → `Draft`; `GET /drafts?workspace=&session=` (phase 2) mirrors `/moments`
(unknown workspace ⇒ `[]`, not an error). No placeholder existed in events.ts to correct.

### The register visibly shapes the draft (the exit-criterion evidence)
The Actor resolves voice exactly like the distiller: a session `registerId` becomes a session-scope
binding that wins over the mode-default (`mode.registerId`) by session > mode precedence; stored
bindings still out-rank both. The `tpl-followup-default` template (kind `act`, seeded, versioned,
cloneable) interpolates the dial numbers **and** the compiled `{{voice.rules}}`. The
register-shaping test seeds identical session material and drafts it twice — boardroom (mode default:
charm 2 / specificity 9) vs a sales-floor session register (charm 8): with a prompt-echoing fake llm
the two draft bodies differ (`Avoid humor … stay clinical` + `specificity 9/10` vs `Be personable and
charismatic` + `charm 8/10`), and `assert.notEqual(bodyA, bodyB)`. This mirrors the slice-4 e2e and is
the constructional half of the exit criterion; the experiential half (a human judges the two real
drafts read differently) is convergence-time, on real models.

### Flag — `act.enabled` (umbrella, OFF, scope engine, minTier T1)
Named to mirror the distill family: `distill.enabled` gates the core pass; `act.enabled` gates the
core act. Future act kinds (task-extract, nudge) become sub-flags `act.tasks`/`act.nudge`, exactly as
`distill.moments`/`distill.index` extend `distill.enabled`. Read at trigger time (per session-end), so
an API flip takes effect without restart. **Interaction with distill flags:** the draft is composed
from stored distillates/moments, so with `distill.enabled` off there is nothing to draft and no draft
is produced (a normal outcome, logged — not an error, not a hard flag dependency). Moments enrich the
draft but are not required; a draft composes from distillates alone. Seeded in `flag.examples.json`
(the seed source `ensureDefaultFlags` reads).

### HUD surfacing — DEFERRED (out of slice, not gold-plated)
No `draft` BlockTypeName shipped (BlockTypeName is append-only; adding one is the CONTRIBUTING Tier-B
recipe and the exit criterion only needs the draft to EXIST ≤60s and be retrievable — `GET /drafts`
delivers that). The natural home is a later HUD/editor slice: a `draft` block + a `draft-with`/`copy`
action over the served draft body (the `copy` verb is already live in the renderer).

### Deferred (out of this slice, by scope)
- task-extract + nudge act kinds (enum exists; unimplemented); sending/committing/replying outward
  (hard product rule — never).
- Durable act retry / manual re-compose route (see Retry above); the DAG executor (see DAG decision).
- A `draft` HUD block + surfacing (see above); draft editing/versioning as a document.

### Phase-2 exit criterion — honest status at slice close
Constructionally COMPLETE: attend-a-meeting is exercised end-to-end in tests — session start →
capture spool → drain/distill (+ moments/entities) → HUD hydration → session end → a register-bound
follow-up draft ≤60s, retrievable. What Phase 2 still LACKS for the *lived* criterion (all
convergence-time or separately-scoped, none constructional blockers):
- **Real capture + a content-protected Electron window.** `client/main` is still a Phase-1 scaffold;
  the HUD mounts via a browser dev-entry. Real mic/screen/system-audio capture (glass transplant) and
  the window/tray are a separate follow-up. Today's e2e drives capture over `POST /capture`.
- **Local-model quality on real hardware.** All llm calls in CI are fakes; extraction/draft quality
  on 3–8B models (the #2 risk) is tuned against real meetings over calendar time, not construction.
- **The experiential judgments** — "the HUD is alive and I trust it", "the two drafts read
  differently" as a human reads them — need dogfooding, per CODE_MAP's construction-vs-convergence note.

## Slice: The real client shell — window · menu-bar tray · hide (post-Phase-2-code convergence)

This is convergence work *after* the Phase-2 code was complete: Phase 1 added no Electron code and the
HUD mounted only via a browser dev-entry (see "Where the HUD mounts today" above). This slice gives the
thin client its actual shell — the CODE_MAP `client/main/` home — closing that follow-up. No new blocks,
no new engine routes, no capture. Scope was deliberately tight (the founder asked for tight).

### What landed
A macOS menu-bar app (`apps/client/src/main/`): one frameless, transparent, always-on-top HUD window
with `setContentProtection(true)`; a tray whose menu toggles the window and the session and reflects
live state; ⌘\ toggles visibility. Run it with **`pnpm --filter @openinfo/client start`** (builds, then
`electron .`) against a running engine.

### Renderer transport — the browser HudTransport, no preload bridge (simplest correct wiring)
The renderer is Chromium: it already has `fetch`/`WebSocket`/`document`/`navigator.clipboard`. So the
Electron window loads `apps/client/hud.html`, which hosts the **exact compiled dev entry the browser
harness uses** (`dev-entry.js` → `BrowserTransport`) — zero renderer/controller change, precisely as the
HUD slice scoped this follow-up. A preload bridge was considered and rejected: it would only be needed
to reach node-bound APIs, but the HUD needs none — it reads the engine over HTTP+WS like any browser.
`EngineLink` is *not* used in the renderer (it pulls `node:fs` for the capture spool and can't load
there). The main process sets the engine URL via `loadFile(hud.html, { search: 'engine=…' })`.
`hud.html` differs from `dev-hud.html` only by a transparency override (the shared stylesheet's `.stage`
paints an opaque backdrop for a full browser tab; in a transparent window we want just the glass panel
to float, so `.stage`/`body` background is forced transparent with `!important`).

### Tray menu + live-session state — WS push, not polling
Menu: a disabled **status header** (● session live / ○ no session / ○ connecting…), **Show/Hide HUD**,
**Start Session / End Session** (the founder's on/off toggle — one item whose label + verb flip with the
live state), and **Quit**. The tooltip mirrors the status. Live state is tracked from the engine **WS
stream** (`session.started`/`session.ended`) via `SessionLiveState`, seeded by one initial
`GET /sessions?live` on connect (+ on reconnect). **WS over polling** because it is push: zero idle cost,
instant reflection, and it reuses the same event feed the HUD already consumes; a poll would add fixed
latency and waste requests while nothing changes. Start/End is disabled until the first seed returns, so
the menu never asserts a state we haven't confirmed. Start targets `ShellConfig.workspace`/`.modeId`; the
engine's start-while-live auto-end (sessions slice) means "Start" always just works.

### ⌘\ and content-protection on this Electron/macOS (Electron 38, darwin 25.3, verified)
- `globalShortcut.register('CommandOrControl+\\', …)` after `app.whenReady()`; `unregisterAll()` on
  `will-quit`. Registration returned true on this machine (logged). `CommandOrControl` is the portable
  token (⌘ on macOS). Nothing extra was required.
- `win.setContentProtection(true)` maps to `NSWindowSharingNone` on macOS (per Electron docs) — the
  window is excluded from screen capture/share. **Honest caveat from the docs:** newer capturers built on
  **ScreenCaptureKit** may still capture a content-protected window; NSWindowSharingNone is the ceiling
  Electron exposes. Protection can't be screenshot-verified from code, so the shell **logs** it
  (`content-protection: ON`) at window creation — asserted in the verification run below.
- The window is `focusable: false` and shown via `showInactive()` so it never steals focus (a glance,
  not a workspace); `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` keeps it present over
  other spaces/fullscreen apps (Glass behaviour); `app.dock.hide()` makes it a menu-bar-only agent.

### Flag vs config — client-local CONFIG, no flag documents (consistent with sessions/HUD)
Shell behaviours (always-on-top, content-protection, frameless, ⌘\, the tray, which engine to talk to)
are **client-local config resolved from env** (`config.ts`), **not flag documents**. A flag is an
engine-side, DB-backed, `/flags`-served record that gates **engine processing behaviour**; these
behaviours never touch the engine or its store — they are how the client paints its own window. This is
the same line the sessions and HUD slices drew (flags gate engine processing; a resource route, a
lifecycle record, or a client window are none of those). A `window.alwaysOnTop` flag would live in the
engine and mean nothing there. So: no new flags, no new engine routes — as scoped.

### Testability — pure logic, electron-free CI
CI builds/tests headless, so all logic is pure and node-tested: the window-options builder (asserts
frameless/transparent/always-on-top + the content-protection/all-workspaces hardening), the tray state
machine (label/verb flips, disabled-until-connected, status/tooltip), the shortcut→command map, the
config resolver, the session client (against a **stubbed fetch**), and `SessionLiveState` (fed fake WS
events). Only `shell.ts` imports `electron`, and the `*.test.js` glob never matches it. Adding `electron`
as a devDependency did **not** require a tsconfig split: `skipLibCheck` (already on) absorbs electron's
internal DOM lib references, and `shell.ts` itself uses only node globals (`WebSocket`, `URLSearchParams`),
so the package stays `types: ["node"]` and type-checks the shell code fully. (+22 client tests: 29 total.)

### Live machine verification (darwin 25.3, Electron 38, Node 25) — what actually ran
- `electron .` launched against a local engine (on :8899 — see gotcha below). Main-process log showed
  `HUD window created — content-protection: ON` and `shortcut CommandOrControl+\ → toggle-visibility:
  registered`; the renderer loaded `hud.html` and ran the HUD entry (only a benign dev CSP warning, no
  fetch errors); 7 Electron processes (window + helpers) stayed resident. `GET /layouts/surfaces/
  surf-openinfo-hud` served the HUD document the renderer hydrates.
- **Session round-trip through the shell's own `EngineSessionClient` + `SessionLiveState`** (the exact
  code the tray calls): `startSession` → engine-stamped id; `session.started` arrived over WS and flipped
  `SessionLiveState.live` → true (this is what turns the tray to "End Session" / "● session live");
  `endSession` → `endedAt` stamped; `session.ended` over WS flipped it back to false. Confirmed via
  `GET /sessions`.
- **Could not automate** in this headless-automation context: the visual appearance of the transparent
  window, a real tray *click*, and a real ⌘\ keypress. Registration/creation/protection are asserted from
  logs; the session toggle's engine round-trip and live-state reflection are exercised directly through
  the shell modules. Nothing broke on this Electron/macOS combo — no glass-transplant friction at the
  window/tray/shortcut layer (real *capture* is the next slice, where that risk lives).
- **Gotcha (not a code issue):** an unrelated service already held :8787 on the dev machine, so the engine
  was run on :8899 (`OPENINFO_PORT=8899`, and the shell pointed at it via the same env). The default
  remains :8787.

### The audio path — what the real-capture slice still needs (findings, per task)
Read of the current capture/distill/fabric wiring, to scope the NEXT slice honestly:
- **`CaptureChunk`** (contracts) carries `{ source, contentType, encoding: 'utf8'|'base64', data, … }`.
  The distiller (`distill/distiller.ts`) filters to **`encoding === 'utf8'` only** (`isText`) — base64
  frames are explicitly deferred to OCR (P3). So a `/capture/mic` POST carrying **base64 audio would be
  accepted and spooled but dropped by distill** — it produces nothing today.
- **The `stt` fabric slot is not wired to anything that transcribes.** `stt` appears only in
  `fabric/bench.ts` (health/throughput probe) and the empty default slot list; there is **no
  `invoke`-style STT path** (only `fabric/invoke.ts::invokeLlm` exists, for the llm slot). So there is no
  audio→text step anywhere in the engine.
- **Therefore** an Electron-renderer `getUserMedia → POST /capture/mic` (base64 audio) would **not** yield
  anything distill can use today. The real-capture slice needs, minimally: (1) an `stt` invoke path in the
  fabric (mirroring `invokeLlm`) resolving the `stt` slot's endpoints; (2) a drain/distill step that runs
  audio chunks through `stt` to produce utf8 text chunks (or transcript records) **before** the text
  filter — i.e. transcription is the missing pre-distill stage; (3) the client capture modules
  (`capture/mic.ts` etc., glass transplant) emitting chunks. The seam itself already works: the Phase-1
  `capture/sim.ts` + `EngineLink.capture` prove chunk POST + offline spool; only the *audio→text* stage
  and the real OS capture are absent. Text capture works end-to-end **now** (POST a utf8 chunk → distill).

### Deferred (out of this slice, by scope)
- Real mic/screen/system-audio capture + AEC (next slice — see audio findings above); auto-updater;
  packaging/signing/notarization (a plain `electron .` dev run is the deliverable); Windows/Linux polish.
- Settings/editors/palette UI; a tray "engine picker"; multi-workspace tray targeting (one workspace today).
- Tray click / ⌘\ keypress automated UI tests (need a display-bearing harness, e.g. Playwright-for-Electron).

## Slice: STT in the fabric + transcription riding the drain (the engine half of real-capture)

The shell slice's audio findings (above) were the scope: `CaptureChunk` accepted base64 audio but the
distiller dropped everything non-`utf8`, and the `stt` slot was wired to nothing (`bench` health probe
only). This slice makes audio mean something — the ENGINE half. Client capture (mic/loopback/AEC) is a
separate pending slice; this ships only what the engine needs so that when audio arrives it becomes
distilled text/moments/entities exactly like typed capture does today.

### `invokeStt` — mirrors `invokeLlm`, the stt slot's first-healthy-wins seam
`fabric/invoke.ts::invokeStt(fabric, audio, opts)` iterates `fabric.slots.stt` in fabric order (first
that answers wins), POSTing the OpenAI-compatible **`/v1/audio/transcriptions` multipart** shape
(`model` + `file` form fields; whisper.cpp / faster-whisper-server style local servers) for `http`
endpoints. `local` is a stub (skipped) and `cloud` is out of scope — **identical handling to invokeLlm**
(offline local runtimes land with managed runtimes later; cloud is enhancement, never dependency). The
`file` part's filename is sniffed from `contentType` (`audio/wav`→`audio.wav`, `audio/mpeg`→`audio.mp3`,
…) so the transcriber can detect the container. Returns `{ text, endpoint, model?, slot: 'stt' }` — same
provenance shape as `LlmResult`, so a transcribed chunk is traceable to the endpoint/model that made it.
- **Error/timeout semantics (consistent with invokeLlm):** throws on transport OR protocol failure
  (`!response.ok`, or a response with no string `text`) so the caller falls through to the next endpoint;
  if none answer it throws with the per-endpoint failure list. Timeout defaults to **60s** (vs invokeLlm's
  30s) — audio decode + transcription can outlast a chat completion — overridable via `opts.timeoutMs`.
- **Empty transcript (`''`) is a valid SILENCE result, not an error** — a transcriber that answers must
  return a string `text`; missing `text` is the protocol error, `''` is normal silence.

### Transcription as a pre-distill DRAIN STAGE (`distill/transcribe.ts`), not inside the distiller
`transcribeChunks(chunks, { invoke, language? })` runs in the drain processor **before** the distiller's
`isText` filter: base64 `audio/*` chunks are transcribed via the stt slot and rewritten as `utf8`
`text/plain` chunks (**source preserved**), then flow into the ordinary distill pass unchanged. It lives
as a distill-pipeline stage (like moments/index ride the same pass) but runs as a distinct processor step
in `http.ts` — the distiller stays audio-agnostic; it only ever sees text, exactly as before.
- **How audio is identified:** `encoding === 'base64' && contentType startsWith 'audio/'`. This is the
  contract the client capture slice emits for mic/system-audio (e.g. `audio/wav`, `audio/webm`). Base64
  chunks with a non-audio contentType (screen frames — `image/*`) are **NOT** audio and **pass through
  untouched** (the distiller's `isText` then drops them; OCR is P3, deliberately not built here). `utf8`
  chunks are already text and are never sent to stt.
- **Failure = transport failure = re-queue.** `transcribeChunks` never swallows an `invoke` error; it
  propagates → the drain processor throws → `CaptureQueue` renames the spool file back to pending (the
  existing retry-at-idle). Nothing is lost; the raw audio stays durably spooled until a later drain
  transcribes it. This is precisely how distill behaves with no llm endpoint up today.
- **Silence is a zero-text outcome, not an error:** an empty transcript yields NO text chunk (dropped,
  logged). If every chunk is silence the window produces no distillate — a normal empty result.

### Speaker attribution for free — the me/them split carried as a transcript-line PREFIX
The capture SOURCE is the speaker: `mic` is the user (**"me"**), loopback `system-audio` is the far side
(**"them"**). `speakerLabel(source)` maps this (other sources have no speaker in v0). The mechanism —
chosen as the least-invasive carry — is **the distiller's window-transcript builder prefixes each line
with its chunk's speaker label** (`me: …` / `them: …`; bare for sourceless kinds). Rationale for prefix
over per-chunk stamping: a merge window can mix mic + system-audio chunks, so there is no single window
speaker to stamp; the prefix puts the attribution exactly where every downstream prompt already reads it
(`{{transcript}}` feeds the summary AND the moment/entity extraction prompts unchanged). The moments
extractor then echoes it into `Moment.speaker` when the model emits one (`Moment.speaker` is documented
as "person entity id or raw label" — `me`/`them` is a raw label until voice→person identity, which is
**P7**; this is explicitly **NOT diarization** — it's the physical capture split, so it costs nothing).
Transcription preserves `source` on the produced text chunk so this split survives the audio→text step.

### Contract touch — `CaptureSource` gains `system-audio` (additive)
`CaptureSource` (api/payloads.ts) and `Moment.source` (records/moment.ts — a parallel inline union, kept
in lockstep) gain `'system-audio'`, appended. Additive and backward-compatible, mirroring the
`Moment.provenance` precedent: every Phase-0/1/2 example still validates. `Moment.source` had to change
too because a transcribed system-audio chunk keeps `source: 'system-audio'`, and a moment extracted over
it stamps that source — the full-record `Value.Check` in the moments extractor would otherwise drop it.
Schemas regenerated (`pnpm --filter @openinfo/contracts gen` → CaptureSource/CaptureChunk/Moment/
RelevantEntity), new `captureChunk.system-audio.json` example (base64 `audio/wav`) validates.

### Flag — `distill.transcribe` (OFF, scope engine, minTier T1), NOT `capture.stt`
Named into the distill family (`distill.enabled` → `distill.moments`/`distill.index`/`distill.transcribe`)
because it is a STAGE of the distill pass, gated by `distill.enabled`, and read per-drain like its
siblings (an API flip takes effect without restart). `capture.stt` was rejected: it would imply a
capture-side concern independent of distill, which contradicts the gating decision below.
- **Interaction (decided + documented): transcription only runs INSIDE `distill.enabled`.** There is no
  persistence path for transcribed-but-undistilled text in v0 — the drain consumes raw chunks and emits
  distillates; it has no "transcribed chunk" store, and re-spooling transcribed text as fresh chunks
  would be a durable-capture feature of its own. So running stt when nothing will distill the result is
  pure waste. Therefore: `distill.enabled` off ⇒ raw chunks (audio included) are GC'd unprocessed exactly
  as all capture is today (the Phase-1 no-op-GC path) — flipping `distill.transcribe` alone does nothing.
  `distill.enabled` on + `distill.transcribe` off ⇒ today's behavior (audio spooled, dropped by `isText`).
  `distill.enabled` on + `distill.transcribe` on ⇒ audio transcribed then distilled. Not a hard *code*
  dependency (transcribe is a plain function); a wiring-level gate, same spirit as moments/index requiring
  distill.enabled.

### Tests (+11 engine: 79 total; contracts 28; client 29 — all green, `pnpm -r build`/`-r test`)
- `fabric/stt.test.ts` — invokeStt against a fake in-process STT http server (mirrors the fake-llm
  pattern): multipart shape (model + `filename="audio.wav"`) + provenance; empty-transcript silence;
  first-healthy fallthrough; empty-slot throws + local/cloud skipped.
- `distill/transcribe.test.ts` — unit (injected fake stt): audio→text with source preserved, silence
  dropped, screen-frame + utf8 passthrough (stt never called), transport failure propagates. E2e (fake
  stt + fake llm chained through the real `CaptureQueue` drain processor): audio→transcribe→distill with
  **me/them prefixes asserted in the llm prompt**; a transport failure re-queues the spool file (pending
  stays 1, nothing distilled); flag-off = current behavior (audio dropped, no llm call).

### What the client capture slice can now rely on
- POST a `CaptureChunk` with `encoding: 'base64'`, `contentType: 'audio/<container>'` (e.g. `audio/wav`,
  `audio/webm`), `source: 'mic'` (the user) or `source: 'system-audio'` (loopback / far side) to
  `/capture/:source`. With `distill.enabled` + `distill.transcribe` on and an `stt` http endpoint in the
  fabric, it is transcribed and distilled into the same distillates/moments/entities as text capture.
- The me/them speaker split is automatic from `source` — the client does NOT need to diarize or label.
- Everything degrades safely offline: no stt endpoint up ⇒ the file re-queues (retry-at-idle), never lost.
- Unchanged: the seam itself (`POST /capture` + offline spool) and text capture end-to-end. This slice
  added no client code and touched no client shell (the concurrent window-drag slice owns that).

### Deferred (out of this slice, by scope)
- Client OS capture (getUserMedia / system-audio loopback / AEC — the glass transplant, pending a spike);
  OCR / screen understanding (P3, screen `image/*` frames pass through untouched); engine-managed local
  stt runtimes (http endpoints only, like llm); diarization / voice→person identity (P7 — `me`/`them` is
  a raw label, not an entity id); retry-at-idle `llm.smart`/`stt` re-transcription upgrades (the queue
  seam supports it, endpoint tiering still unwired); a durable transcribed-text store for transcribe-
  without-distill (no consumer for it yet — see flag interaction).

## Slice: The HUD window moves + remembers where you put it (drag · position persistence)

A tight follow-up to the client shell slice above. The founder hit it immediately: the frameless HUD
was **static — it couldn't be dragged**. This slice makes the header strip a grab handle, moves the
window with the cursor, and remembers the spot across restarts. No engine/contracts change (client-only,
`apps/client`), no resizing, no multi-display UI — deliberately tight.

### The drag path that shipped: IPC cursor-follow, NOT CSS `-webkit-app-region: drag`
The primary approach was the CSS drag region (`-webkit-app-region: drag` on the panel header). It does
**not** work here, and by design it can't: the HUD is **`focusable: false`** (a glance, never a window
you work in — the shell slice's deliberate no-focus-steal decision, which this slice must not flip). On
macOS that CSS region rides the AppKit window-drag, which only engages for a **focusable** window, so the
region is inert. So the shipped path is the IPC manual-drag pattern, and `focusable: false` stays:

- A **mousedown on the `.hudtop` strip** (renderer) → the preload bridge (`window.openinfoDrag.start()`)
  → `ipcMain` `hud:drag-start`. The main process captures the **grab offset** (cursor − window origin)
  once, then on a ~60 Hz tick reads `screen.getCursorScreenPoint()` and `setPosition`s the window so the
  grabbed point stays under the cursor. Any mouseup / pointer-leave → `hud:drag-end` stops the tick. The
  move happens **in the main process off the live OS cursor**, which is exactly why it works while the
  window is non-focusable — nothing depends on the window becoming key.
- The grab strip is the existing header (`.hudtop`, the context/heartbeat line — hud-v2.html's title-bar
  equivalent), not new chrome. Interactive descendants (`.mini`, `[data-verb]`) are excluded from the hit
  test, so dragging the header never swallows an action click. `cursor: grab`/`grabbing` is the affordance.

### The one preload — a two-verb drag channel, `contextIsolation` on, `nodeIntegration` off
The shell slice shipped **no** preload (the HUD reads the engine over HTTP+WS like any browser). Dragging
is the single thing the renderer can't do itself, so this adds a minimal `contextBridge` preload exposing
a **coordinate-free** `start()`/`end()` (main reads the cursor; the renderer sends no geometry). No node
surface reaches the page; `contextIsolation` stays on, `nodeIntegration` off — only the two IPC channels
cross. In a plain browser (`dev-hud.html`) there is no bridge, so the drag wiring simply isn't installed
and the browser HUD is unaffected. **`.cts` gotcha:** the client package is `type: module`, but Electron
loads a `.js` preload as CommonJS, so an ESM preload fails to parse. Authoring the source as `preload.cts`
makes `tsc` emit a real `preload.cjs` (CommonJS, `contextBridge`/`ipcRenderer` available under the default
sandbox) — no sandbox flip, no build hack, still strict TypeScript. (`tsconfig` `include` gained `*.cts`.)

### Position persistence — client-local JSON, on-screen-validated on restore
The origin is saved (debounced, ~400 ms, on `moved` and on drag-end) to a tiny `window-state.json` under
Electron's `userData` — **client-local config, not a flag document**, the same line the shell/sessions/HUD
slices drew (where a window sits is how the client paints itself; it never reaches the engine or its
store). On startup the saved origin is restored **only if it is still landable on a currently connected
display** (≥80 px visible in both axes and the top/grab strip within the work area). An unplugged monitor
or resolution change → the spot fails the check → the shell **centers** instead, so the HUD can never open
off every screen where you couldn't drag it back. Fails closed.

### Testability — same pure/shell split
New pure logic is node-tested headless (no display, no `BrowserWindow`): the drag geometry (`grabOffset`
→ `draggedOrigin` keeps the grabbed point under the cursor), the (de)serialize/parse (rejecting garbage),
the on-screen validation (unplugged-monitor, off-top, sliver, secondary-display cases), the disk
round-trip (`window-store` against a temp dir), and the renderer hit-testing (`window-drag`: the strip
drags, an action button never does, non-primary buttons don't, pointer-leave ends). The `electron`-importing
files stay untested-by-CI as before — now `shell.ts` **and** `preload.cts`. (+24 client tests: 51 total.)

### Live machine verification (darwin 25.3, Electron 38, Node 25) — what actually ran
The engine ran on **:8901** (:8787 is held by an unrelated service on this box; :8899 was the shell slice's
pick — the default stays :8787). Verified against a real display:
- **Real shell boots clean** with the new code: `electron apps/client` logged `HUD window created —
  content-protection: ON`, then the new position branch, then `shortcut … registered` — no errors.
- **`setPosition` moves a `focusable: false` window** — a harness built the window from the *real*
  `hudWindowSpec` (focusable:false/frameless/transparent) and moved it `300,270 → 640,480` (PASS). This is
  the primitive the whole drag rides.
- **The full renderer→main drag chain fires under `focusable: false`**: the *real* `preload.cjs` exposed
  `window.openinfoDrag` (typeof `object`, `.start` a function — `contextIsolation` on); a genuine
  `MouseEvent('mousedown')` on the rendered `.hudtop` propagated through the shipped `window-drag` wiring →
  bridge → IPC, and `ipcMain` **received `hud:drag-start` and `hud:drag-end`** in the main process.
- **Persistence round-trip through the real shell**: seeding `window-state.json` with an on-screen origin
  → `HUD position restored to 250,180`; seeding an off-screen origin (`5000,5000`) → `no usable saved HUD
  position — centered`. The debounced save writes the same JSON shape the restore reads.
- **Could not automate** (same ceiling the shell slice documented): a *physical* mouse drag — `cliclick`
  needs Accessibility privileges this headless-automation context can't grant, so synthetic OS mouse input
  is unavailable. Every *software* link is exercised above; the only unproven step is the OS delivering a
  real pointer-down to the strip — and the shipped HUD already depends on real clicks reaching this same
  `focusable: false` window (the copy buttons), consistent with macOS routing mouse input to non-key windows.

### Deferred (out of this slice, by scope)
- **⌘+arrow nudge (skipped, deliberately):** the shortcut machinery is `globalShortcut` — a global
  ⌘+arrow would hijack system-wide text-editing keys (line start/end, etc.) for a marginal gain over
  dragging. Not worth the surface; the grab strip covers repositioning.
- Resizing, snap-to-edges, multi-display placement UI, opacity — all out of scope as stated.

## Slice: Real microphone capture in the client (MIC ONLY — the client half of real-capture)

The engine half (STT + transcribe-on-drain) shipped in the STT slice above; the shell + hidden-window
groundwork was laid by the client-shell and drag slices. This slice makes the client actually LISTEN:
while a session is live it captures the microphone and streams timed audio chunks to `/capture/mic`,
so — with `distill.enabled` + `distill.transcribe` on and an `stt` endpoint in the fabric — a spoken
meeting becomes distillates/moments/entities. MIC ONLY: system-audio/loopback/AEC is a separate
pending slice (concurrent spike), screen/Δ-gate is P3. No engine or contracts change.

### The pipeline — a hidden BrowserWindow captures, the main process wraps + spools
getUserMedia needs a renderer, so the mic lives in a dedicated **hidden** `BrowserWindow` (`show:
false`, never revealed, no content-protection — nothing on screen to hide; `backgroundThrottling:
false` so recording stays steady while the app is a background menu-bar agent; `contextIsolation` on,
`nodeIntegration` off). Its renderer (`capture/mic-renderer.ts`, loaded by `capture.html`) runs
getUserMedia + MediaRecorder and hands each finished segment to the main process over a minimal
`.cts` contextBridge preload (`capture/mic-preload.cts` → `.cjs`, exactly the drag preload's pattern:
`window.openinfoMic` with coordinate-free start/stop down + segment/status/stopped up). The **main
process** (`shell.ts`) wraps each segment as a `CaptureChunk` (base64, monotonic sequence, the live
session's ids) and sends it via the **existing `EngineLink`** path (a main-process EngineLink with a
`capture-spool` dir under `userData` + its flush loop), so the Phase-1 offline spool keeps working
unchanged (mid-capture engine disconnect ⇒ chunks spool, flush when it returns).

### Segmenting — stop/restart, NOT `timeslice`; 8-second segments
`MediaRecorder`'s `timeslice` emits fragments of ONE webm stream — only the first fragment carries the
container header, so later fragments are **not independently decodable** and an STT server can't
transcribe them alone. So the renderer **stops and immediately restarts** the recorder each segment,
yielding a COMPLETE, self-contained webm file (header + data) per segment — exactly what
`/v1/audio/transcriptions` needs. The sub-frame gap at each boundary is negligible for speech (the
engine re-merges chunks into 30s–2m distill windows anyway). **8s** was chosen from the 5–10s band: long
enough to amortize per-request + stop/restart overhead and keep boundaries rare, short enough that audio
reaches the engine promptly and the flushed final segment on session-end is small.

### Container/encoding — webm/opus (`audio/webm`), verified against the engine sniff
Chosen **webm/opus** (MediaRecorder-native — zero extra code) over raw PCM→WAV (an AudioWorklet, more
code). Verified the engine's STT multipart filename mapping handles it: `fabric/invoke.ts::audioFilename`
splits on `;` and maps `audio/webm`(`;codecs=opus`) → **`audio.webm`** (confirmed live — the fake STT
saw `filename="audio.webm"`). `chunk.ts::normalizeContentType` strips the `;codecs=…` param so both forms
collapse to the bare `audio/webm` the sniff expects. **Tradeoff / what servers accept:** webm/opus is
accepted by ffmpeg-backed OpenAI-compatible servers (faster-whisper-server, speaches, the OpenAI API);
a stock **whisper.cpp** `server` wants WAV (16 kHz PCM) and would reject webm. If a WAV-only backend is
the target, WAV-via-AudioWorklet is the documented fallback (the seam is unchanged — only the renderer's
encoder swaps and `contentType` becomes `audio/wav`). Emitted `contentType` is always bare `audio/*`, as
the engine's audio sniff requires.

### Lifecycle — the tray Start/End IS the mic switch (zero new UI)
Capture is driven entirely by the existing `SessionLiveState`: `shell.ts` mirrors its `onChange(live)`
into the controller — a live session ⇒ `onSessionStarted({ sessionId, workspaceId })`, ended ⇒
`onSessionEnded()`. The pure `MicCaptureController` (`capture/mic-controller.ts`) is the state machine:
`idle → requesting → capturing → (end) flush → idle`. Edge cases handled + tested:
- **Session ends mid-segment:** end tells the renderer to stop; MediaRecorder's `onstop` flushes the
  final (partial) segment, which the controller still wraps under the ENDING session's ids (it holds the
  context until the renderer confirms `stopped`), then clears.
- **Auto-end → immediate restart** (start-while-live emits ended(A) then started(B)): a start arriving
  while A is still flushing is **queued** (`pendingStart`) and applied only after A confirms stopped, so
  A's final segment never gets B's ids. Sequence resets per run.
- **Mid-capture engine disconnect:** EngineLink spools (nothing lost); the flush loop drains on return.
- **App quit during capture:** `before-quit` → `controller.shutdown()` stops the renderer cleanly.

### Permission — `askForMediaAccess('microphone')`, denial degrades gracefully
On the first capture the controller calls `requestPermission` → `systemPreferences.askForMediaAccess`
('microphone') on macOS (non-macOS resolves true; a Chromium permission handler grants only `media` to
our windows). **Denial disables audio only** — the controller enters `denied`, never starts the
renderer, ignores stray segments, and **the session/text path is completely unaffected** (no crash).
A privacy-honest recording indicator lives in the tray with zero new UI: the status header + tooltip
show **`● rec`** while capturing and **`mic blocked`** on denial (`tray-menu.ts`, pure + tested).

### Config — `OPENINFO_MIC` (client-local, opt-OUT, default ON), NOT a flag
`ShellConfig.micEnabled` from `OPENINFO_MIC` (only `0`/`false`/`off`/`no` disables). Default **ON when a
session runs** — the **session is the consent gesture**, so a running session listens unless explicitly
muted. This is CONFIG not a flag, the same line the shell/sessions/HUD slices drew: it is how the client
uses its own hardware, it never reaches the engine or its store, and whether captured audio MEANS
anything is ALREADY gated engine-side by `distill.transcribe`. A client `capture.mic` flag would be an
engine-side DB record gating nothing the engine can see — the wrong home. No engine flags added (correct
per scope — engine gating already exists).

### Testability — the same pure/shell split, electron-free CI (+14 client tests: 65 total)
All decision-bearing logic is pure and node-tested headless: `chunk.ts` (shape/base64 round-trip/
contentType normalization/sequence), `mic-controller.ts` (full lifecycle incl. in-flight flush, denial,
disabled config, auto-end serialization, shutdown; renderer-reported denial), the IPC protocol shape,
and **spool integration** through a real `EngineLink` to a dead port (chunks durably spool, nothing
thrown). The electron/DOM-touching files stay untested-by-CI, as before: `mic-renderer.ts` (browser
globals — typed via one structural `globalThis` cast, the mount.ts trick, so the package stays
`types:["node"]`), `mic-preload.cts`, and the `shell.ts` wiring. `pnpm -r build` + `pnpm -r test` green
(contracts 28 · client 65 · engine 79; the seam.test.ts port TOCTOU flake did not recur this run).

### Live verification (darwin 25.3, Electron 38, Node 25) — what physically ran
- **Audio → distillate END-TO-END through the real client code path**, without the OS mic: a driver
  built the real `MicCaptureController` exactly as `shell.ts` does (stubbing only the two electron edges
  — renderer control + permission) and fed real `say`-generated audio bytes as segments against an
  engine on :8903 (scratch `OPENINFO_DATA`) with a fake STT+llm fabric (:8904) and `distill.enabled`/
  `distill.transcribe`/`distill.moments` on. The engine logged `transcribe: mic chunk
  mic-<sessionId>-000001 → 51 chars via fake-stt` (our chunk-id format), the fake STT saw
  **`filename="audio.webm"`** (the container decision proven through the multipart sniff), the fake llm
  **saw the transcribed text** in its prompt, and a distillate landed: `distilled window … (4 chunks) via
  fake-llm`. The queue drained clean. This proves everything `shell.ts` wires — chunk assembly →
  EngineLink POST → engine arrival → transcribe → distill — EXCEPT getUserMedia itself.
- **The real Electron shell boots the pipeline clean:** logs showed `hidden capture window created — mic
  renderer host`, `mic capture enabled (follows the session lifecycle)`, HUD `content-protection: ON`,
  and `⌘\` registered. Starting a session over the API drove the lifecycle: `mic access status before
  request: not-determined` → on `askForMediaAccess` → **`microphone access denied — capture disabled,
  session continues (text path unaffected)`** — the denial path, live, no crash.
- **The TCC wall (honest, as the task predicted):** this headless-automation context cannot present or
  click the macOS microphone permission dialog, so `askForMediaAccess` resolved **denied** and no real
  mic audio was captured through getUserMedia. **The exact remaining human step:** a person launches the
  app (`pnpm --filter @openinfo/client start`), starts a session from the tray, and clicks **Allow** on
  the macOS mic prompt (or enables the app under System Settings → Privacy & Security → Microphone). Then
  the hidden window's getUserMedia captures real audio, which flows through the very path proven above
  with synthetic audio. Everything up to that single click is verified.

### Deferred (out of this slice, by scope)
- System-audio / loopback / AEC (concurrent spike + separate slice); screen capture / Δ-gate (P3 — frames
  would spool for nothing until OCR); WAV/AudioWorklet encoder (documented fallback, not built — webm
  suffices for ffmpeg-backed servers); per-source on/off + cadence in a settings/palette UI (P6);
  diarization / voice→person (P7 — `me`/`them` is the free source-based split, not identity); packaging/
  signing. Audio-quality tuning (sample rate, VAD-gated segmentation to skip silence) is convergence-time.

## Spike answer: AEC / loopback (retires the `glass-capture` row's remaining question)

Throwaway spike in `spikes/aec-loopback/` (runnable in one command; `npm install && npm start`). It
grants a `getDisplayMedia` request with `audio: 'loopback'` in the main process, then captures the mic
in three configs — **A** `echoCancellation:false` (baseline), **B** `echoCancellation:true` (option 1,
Chromium/OS AEC), **C** `echoCancellation:true` + the AEC3 far-end trick (option 2, loopback piped
through a local `RTCPeerConnection` as a render reference) — while playing a known 440 Hz tone out the
speakers, and measures mic RMS during tone vs silence (leakage) plus mic↔loopback cross-correlation.
Machine: **darwin 25 (macOS 26.3.1), Electron 38.8.6, Node 25**.

**Loopback verdict — native string loopback does NOT capture system audio on macOS.** Electron's own
docs are explicit: the `callback({ audio: 'loopback' | 'loopbackWithMute' })` string form is *"Windows
only for loopback."* On macOS `getDisplayMedia` grants a screen **video** track but **no system-audio
track** from the string form. Empirically it failed even earlier here: `desktopCapturer.getSources`
throws because **Screen Recording TCC is denied** (`getDisplayMedia → AbortError: Error starting
capture`, `loopback.gotStream=false`). This matches why Glass shipped a compiled native helper
(SystemAudioDump). **So loopback does NOT remove the need for a system-audio helper on macOS.** Two
routes exist that a later slice must choose between, and it should be a design note before code:
- **(a) Virtual audio device** — e.g. **BlackHole** (already installed on this dev machine; it enumerated
  as both an input and output). Set it as (part of) the output device and capture it as an *input* via
  ordinary `getUserMedia` — **no compiled/native code at all**, but requires installing/bundling an audio
  driver and a multi-output-device routing step the user (or installer) must perform.
- **(b) A small native module** using macOS 14.4+ **Core Audio process taps / ScreenCaptureKit** system
  audio (the modern SystemAudioDump replacement). This is the "no external driver" path but reintroduces a
  compiled helper — smaller and better-supported than Glass's, and the likely path if/when Electron
  exposes macOS loopback natively (track the Electron `setDisplayMediaRequestHandler` loopback support).

**AEC leakage numbers — NOT measurable in this automated run; two stacked walls, reported honestly, no
faking.** (1) **Headless/remote audio:** the microphone delivers *digital silence* in this session —
mic RMS `-inf dB` (all-zero samples) confirmed via **both** the Electron `getUserMedia` path **and** an
independent `ffmpeg` avfoundation capture (`spikes/aec-loopback/measure-baseline.sh`, using ffmpeg's
pre-existing mic TCC grant); a BlackHole loopback capture was silent too. The audio *devices enumerate*
(MacBook Pro Microphone/Speakers, BlackHole, SonoBus) but no live acoustic signal is present, so there is
nothing for AEC to remove and speaker output isn't audibly routed. (2) **TCC, on top:** Electron
Microphone is `not-determined` and the non-interactive `askForMediaAccess` returned `false` (no human to
click), and Screen Recording is `denied`. Either wall alone blocks the measurement; both are present.
- **What WAS validated:** the harness is correct and the digital audio path works — the tone generator
  produced **0.177 RMS** (self-monitored via an AnalyserNode on the tone node, `toneGeneratorWorking:true`
  in `out/results.json`), WAV files are written per config, and the RMS/leakage/cross-correlation pipeline
  runs end-to-end. Only a *live mic signal* + *granted permissions* are missing — both human/hardware, not
  code. `out/results.json` records `summary.micSignalLive:false` and the full permission state.

**Recommendation for the client system-audio + AEC slice** (docs-reasoned where measurement was blocked,
and flagged as such): **default to option 1 — Chromium's built-in `echoCancellation:true`.** In our
topology the far side's audio is *played through the local default output* (the user hears the call), and
Chromium's AEC references exactly that render signal, so built-in EC is the zero-dependency path that
should adequately cancel speaker→mic leakage. **Option 2 (the AEC3 far-end/`RTCPeerConnection` trick) is
only needed if system audio is captured *without* being played locally** (a headless/muted-monitor case),
which is not our HUD scenario — keep it as the documented fallback, not the default. **Option 3 (WASM AEC
built from source) stays a last resort**, justified only if measured residual leakage with option 1 proves
inadequate on real hardware. Note this ranking is not yet backed by a leakage-dB measurement on this
machine — that is the one thing still open.

**Still unanswered (needs a human on live-audio hardware, ~2 min):** the actual per-config leakage numbers
(A vs B vs C in dB) and whether built-in EC is *adequate* vs. needs option 2/3. To complete the spike:
`cd spikes/aec-loopback && npm install && npm start`, then (1) approve the **Microphone** prompt Electron
raises (or enable Electron under System Settings ▸ Privacy & Security ▸ Microphone), (2) enable **Screen
Recording** for Electron in System Settings ▸ Privacy & Security ▸ Screen Recording and **re-run** (screen
grants need an app restart) — on a machine with a live mic + speakers this populates real numbers into
`out/results.json` and writes listenable `out/mic_*.wav` / `out/loopback.wav`. The re-run will also
resolve empirically whether granted Screen Recording yields a macOS system-audio track (expected: no,
per the docs above — confirming route (a)/(b) is required).

## Slice: Fabric profiles + secrets (the dial-able rig — save/clone/switch model setups)

The founder's frame: a first model setup ("config 1") is a *named* configuration that is by no means
the last — 8B in LM Studio today, a 27B on another host + a 4B OCR box + parakeet STT here / TTS there
tomorrow, some of it over tailscale. Any slot→endpoint composition across hosts must be composable,
saveable, cloneable, switchable; hosts + keys are remembered. This is the repo philosophy applied to
the fabric: everything user-configurable is a versioned, cloneable document. Design note landed first
(ARCHITECTURE §8, per CODE_MAP rule 5). ENGINE + CONTRACTS only — the setup page is the next slice.

### The live fabric IS a profile — GET/PUT /fabric stays as the active-profile view (backward compat)
The open question ("does PUT /fabric still exist and what does it mean when a profile is active") was
decided as the note recommended:
- `FabricProfile { id, name, version, fabric, description? }` reuses the existing `Fabric` shape
  verbatim (`fabric` field) — additive reuse, not a fork; existing Fabric callers/examples untouched.
- `FabricDocuments.load()` (the live fabric) = the ACTIVE profile's map, else the pre-profiles legacy
  `config/fabric` doc, else empty. `save()` (PUT /fabric) edits the ACTIVE profile in place (version
  bump) when one is active, else writes the legacy doc. So GET/PUT /fabric behave EXACTLY as before
  for anyone who never touches profiles — the seeded example profiles are **inert until activated**, so
  a fresh install's `GET /fabric` is still the empty map and the README quickstart's "llm slot ships
  empty" promise holds (verified live on :8905). Activation swaps the live fabric atomically; health/
  bench/invoke all run against `fabric.load()`, so they follow the active profile with no change.
- **Delete guards the live fabric:** deleting the active profile is refused (409, "activate another
  first") rather than silently emptying what invoke runs against.

### Secrets — write-only API, never echoed, injected only at invoke time
- Endpoints carry `auth: { keyRef }` (http variant only; additive optional) — a *name*, never a value.
  cloud's existing `auth: 'keychain'` is untouched (P7).
- `SecretStore` is an **interface** (`set`/`delete`/`resolve`/`has`/`listRefs`) so the macOS Keychain
  backend slots in at P7 with zero caller change (CODE_MAP §3). v0 is `FileSecretStore`: one chmod-600
  JSON file in its OWN `secrets/` dir under the data root — decided over the note's "parent dir" wording
  for test isolation + because the export unit is a single workspace `.db`, so a sibling file is never
  in an export regardless; `OPENINFO_SECRETS` overrides for a fully external path. The file is created
  lazily (a fresh install writes nothing) and re-chmod-600 on every write even if it pre-existed.
- **The never-echo guarantee, and how it is enforced + tested:** the value enters ONLY via
  `PUT /fabric/secrets/:ref` (SecretValue, a request-only schema). It leaves ONLY via `resolve()` at
  invoke time, injected into the outbound request as `Authorization: Bearer <resolved>`. Every read
  path returns a bare `SecretRef` (`{ref}`, no value field): the write response, the delete response,
  and `GET /fabric/secrets` (list of refs). No document, GET /fabric response, or event carries key
  material — an endpoint only ever holds the keyRef. Tests assert this by **grepping the serialized
  response/event text** for the actual secret value and asserting absence (PUT/DELETE/list responses,
  GET /fabric, and the fabric.changed event payload), while asserting the keyRef IS present.
- **Header choice:** `Authorization: Bearer` (the OpenAI-compatible convention these endpoints already
  speak). A bespoke header would be an additive `auth.header`/`auth.scheme` field later — not v0.
- **keyRef resolution lives in `fabric/invoke.ts::authHeaders`** (one place): for an http endpoint with
  `auth.keyRef`, resolve via the injected `resolveKey`; if it resolves, add the bearer header; if NOT
  (no resolver, or unknown ref) **throw before any fetch** so the invoke loop catches it, records
  `<name>: missing secret for keyRef "<ref>"` (the REF, never the value), and falls through to the next
  endpoint in fabric order — never crashes, never logs the key. `health.checkEndpoint` mirrors this:
  an authed endpoint with an unresolvable ref reports `ok:false` (graceful), and a resolvable one gets
  the bearer header on the ping. The distiller, actor, and the stt transcribe stage thread the engine's
  `secrets.resolve` as `resolveKey`; omitting it (unit tests) means auth-less endpoints work and authed
  ones fall through — the correct degraded behavior.

### Events + routes the setup-page slice can rely on (exact surface)
- `fabric.changed` → `Fabric` (the now-live map; keyRefs only). Emitted on activate, on PUT /fabric,
  and when the active profile is edited. WS-broadcast like the other events.
- Profiles: `GET /fabric/profiles` (`FabricProfile[]`), `GET|PUT|DELETE /fabric/profiles/:id`
  (PUT create/update — version-bumped; DELETE 200/404/409-if-active), `POST /fabric/profiles/:id/clone`
  (CloneProfileRequest `{id, name?}` → the clone; 409 on duplicate id, 404 on unknown source),
  `POST /fabric/profiles/:id/activate` (→ the activated profile; 404 unknown).
- Secrets: `GET /fabric/secrets` (`SecretRef[]`), `PUT /fabric/secrets/:ref` (SecretValue → SecretRef),
  `DELETE /fabric/secrets/:ref` (→ SecretRef; 404 unknown). All value-free responses.

### Store — profiles are config documents in _meta.db; two small LayoutStore additions
Profiles live via `LayoutStore` like every other config document (kind `fabric-profile`, key = id; the
active pointer is kind `config` key `active-profile`). Two general, minimal store additions rather than
an index-doc hack: `latestOfKind` (latest version per key of a kind — the listing primitive) and
`delete` (hard-delete all versions of a key — the one place version history is discarded, for a config
doc the user explicitly removes). DB-handle rule intact: only store/ opens a handle; FabricProfiles/
FabricDocuments ask it to read/write.

### Seeded profiles (documents, not code)
`lm-studio-local` (LM Studio :1234, openai-compat, one llm), `ollama-local` (Ollama :11434, one llm + a
nomic embedder), `remote-http-template` (a multi-host template: a bigger llm on one box + stt on
another, each authed by keyRef with NO value — clone it, edit URLs/models, wire keys, activate). Seeded
only when absent (never clobbers a user edit) and mirrored as validated `fabricProfile.*.json` examples.

### No flag — deliberately (consistent with sessions/HUD/shell)
Profiles + secrets are resource routes, not gated processing behaviors — the established no-flag line.
What a profile switches on (distill/act) is already gated; a `fabric.profiles` flag would gate nothing
not already gated. (Confirmed, as the task asked.)

### Tests + status (contracts 33 · client 65 · engine 97 — all green; `pnpm -r build`/`-r test`)
+5 contracts examples (3 profiles + 2 secrets), +18 engine (profiles CRUD/clone/activate/version-bump
+ backward-compat load/save; secret round-trip + 0600 + no-leak; llm & stt keyRef injection + graceful
fall-through; API profile CRUD + never-echo security asserts + an e2e proving activation swaps what the
distiller invokes and the profile's keyRef reaches the fake server's Authorization header). Live-checked
on :8905 (:8787 untouched). The known apps/client seam.test.ts port-TOCTOU flake did not recur; a drain-
timing flake in the new activation e2e under concurrent `-r test` load was hardened with a longer wait.

### Deferred (out of this slice, by scope)
- The setup page / any client UI (next slice — forms over the routes above, no new engine capability);
  actual macOS Keychain backend (interface only); cloud endpoint kind; onboarding first-run detection;
  OpenRouter-style model catalogs; migration tooling; a bespoke non-bearer auth header.

## Slice: The first-run setup surface + tray entry (+ the rec-indicator honesty fix)

Slice (b) after fabric profiles+secrets (a). The founder's frame: onboarding is minimal — a *first*
setting, not the user's last. "Config 1" (an 8B in LM Studio) is named, then cloned/switched to a
27B on another host, parakeet STT on a third, any combination. The page is a thin form over the
profile documents slice (a) shipped — forms over documents, **no new engine capability**.

### The page is ENGINE-served at GET /setup — a deviation from CODE_MAP's `client/surfaces/setup/`
CODE_MAP guessed the setup page would live in `client/surfaces/setup/` (a client webview). It landed
**engine-served** instead — the shape ARCHITECTURE §8 actually names ("forms-over-documents served
by the engine, exactly like the coming WYSIWYG editors §6") and consistent with the workbench being
"a web app served by the engine itself … any browser pointed at it". This is the FIRST engine-served
surface, so `engine/surfaces/` gains a real P2 role beyond the block-query compiler (noted in
CODE_MAP). Consequences that make it the right call: it needs no Electron, works against a *remote*
engine from any browser, and the client stays a thin HUD host (no embedded settings UI — explicitly
out of scope). The tray opens it via `shell.openExternal(engineUrl + '/setup')`.

### What the page does (barebones but complete)
- **Profiles:** lists all (seeded ones included), marks the active one (`active · live` badge),
  Activate / Clone (name → slugged id) / Delete. Delete of the active profile is **guarded** — the
  route already 409s ("activate another first"); the page also hides Delete/Activate on the active
  row and surfaces the 409 body in an alert if one still occurs.
- **Editor** (`?edit=<id>` selects the profile; default = active, else first, else the legacy live
  fabric via PUT /fabric): per-slot endpoint rows for **llm + stt** (the slots that DO something
  today) — add / remove / **reorder** (order is fabric fallback) http rows with name / baseUrl /
  model / an optional keyRef dropdown populated from `GET /fabric/secrets`. `tts/vlm/ocr/embed` are
  shown **present-but-inert** with a one-line note (and their existing endpoints are round-tripped on
  save, never dropped). Save PUTs the whole profile (or PUT /fabric for the legacy doc).
- **Secrets:** add a key (ref + value) via `PUT /fabric/secrets/:ref`, delete a ref. The value input
  is write-only — only refs (names) are ever rendered; a stored value is never re-shown (verified
  live: the value never appears in GET /fabric or the page).
- **Test button per endpoint:** `POST /fabric/test` → reachable · latency (· last-measured tok/s if
  the endpoint doc carries one). Failures are honest: `fetch failed` (unreachable), `HTTP 401` with
  a "add a key / the stored value may be wrong" hint, and `unresolved secret keyRef "x"` with a
  "store its value under Keys" hint.
- **First-run notice:** when the LIVE fabric's llm slot is empty, a banner at the top says plainly
  "distill won't run until an llm endpoint exists" — the page IS the onboarding.

### Pure/shell split (engine edition) + how it's served
`surfaces/setup/view.ts` is **pure** (`data → HTML string`, no I/O, no DOM): `firstRunNotice` and the
whole page skeleton are node-tested headless, mirroring the client's pure renderers. `assets.ts` holds
the static CSS + the browser script as string constants (the repo hand-rolls its UI — no framework,
no build step for the page). The script is thin **event-delegation → fetch → `location.reload()`**
after mutations; pre-save endpoint-row edits (add/remove/reorder) are local DOM until Save PUTs the
profile, so a reload never eats unsaved edits mid-form. Round-trip integrity: the editor embeds the
full current fabric as a hidden JSON blob so inert slots + `memoryBudgetMb` survive a save, and each
row carries its kind (non-http rows carry their full JSON) so reorder + mixed kinds serialize faithfully.

### POST /fabric/test + EndpointProbe — a thin read-only helper, not a semantics change
The Test button needed a backing path; `checkEndpoint` (fabric/health.ts) existed but was unrouted.
`POST /fabric/test` exposes it as a **thin, read-only** helper (scope allows "the page + its thin
helpers"): validates an `Endpoint` (the row's current, possibly-unsaved values — so you can test
before saving), resolves any keyRef from the secret store → bearer for the probe, and returns the new
`EndpointProbe` contract `{ ok, latencyMs?, tokPerSec?, error?, hint? }`. It **pings, never invokes a
model** — tok/s is echoed from the endpoint doc's last measured value (tools/bench), not measured
here; the page labels it "(last measured)". The hint mapping (401/403 → key; unresolved keyRef →
store its value) lives server-side so it's tested via the route. No change to invoke/profile/secret
semantics — slice (a) still owns those.

### First-run tray mechanism — a prominent, honest tray item (no popups)
The tray gains **"Set up models…"**; when the live fabric's llm slot is empty it becomes
**"⚠ Set up models…"**. Chosen mechanism (minimal + honest, per scope — no popups/notifications
beyond the tray): a pure `needsModelSetup(fabric)` = `llm slot empty`, seeded on connect from
`GET /fabric` and recomputed on every `fabric.changed` WS event (the event carries the new map — no
refetch). `undefined` (fabric not yet fetched) reads as "not prominent", so the tray never cries wolf
before it knows. Clicking opens `/setup` in the default browser. Config, not a flag — a client window
behaviour, the same line every prior client slice drew.

### The rec-indicator honesty fix — a `starting` state between intent and real audio
`● rec` used to flip the instant permission was granted and the renderer was told to start —
before any audio flowed (getUserMedia + first-segment latency). The mic-controller now distinguishes
**`starting`** (renderer told to start, no segment yet) from **`capturing`** (the FIRST real segment
arrived — audio is genuinely recording). `beginRun` enters `starting`; `onSegment` promotes
`starting → capturing` on the first segment. `onSessionEnded`/`shutdown` treat `starting` like
`capturing` (the renderer holds an open stream either way, so it must be stopped). The tray shows
**`● rec` only for `capturing`**, and a quiet **`○ mic…`** while `starting`/`requesting` — so the dot
never claims to record before a byte exists. Denial path unchanged. Controller + tray tests cover the
new transitions (start → first-segment → rec; end-during-starting still stops the renderer).

### No flag — deliberately (consistent with sessions/HUD/shell/profiles)
Serving a page, probing an endpoint, and the tray's own item are resource routes / client-window
behaviour, not gated engine processing — the established no-flag line. What the fabric switches on
(distill/act) is already gated. **Auth on /setup is out of scope:** the engine is localhost-only
today; a real auth story is a P7 concern (noted in the getSetup doc-comment and the README).

### Tests + status (contracts 34 · client 71 · engine 107 — all green; `pnpm -r build`/`-r test`)
- contracts +1: `endpointProbe.reachable.json` validates against the new `EndpointProbe`.
- engine +10: `surfaces/setup/view.test.ts` (firstRunNotice; skeleton; first-run banner on/off; active
  marked + guarded; llm/stt editable vs inert slots; keyRef dropdown; secrets refs-only) and two
  `http.test.ts` cases (GET /setup 200 + skeleton + seeded profiles + `?edit`; POST /fabric/test
  reachable/401-hint/unresolved-keyRef-hint/400).
- client +7: tray setup-item prominence (⚠ only when llm empty), the `● rec`-vs-`○ mic…` labels, the
  rec-indicator state-machine transitions, `needsModelSetup`, and `EngineSessionClient.fabric()`.
- Known flake (seam.test.ts port TOCTOU) did not recur this run.

### Live verification (darwin, engine on :8906, :8787 left alone, processes killed after)
Full round-trip driven over the API exactly as the page's JS does, plus the page served + opened:
- `GET /setup` → **200**, `text/html`, well-formed (doctype, balanced tags, matched script/template
  blocks, 15 KB); skeleton present (title, first-run banner while llm empty, add-row template, seeded
  profiles each offering Activate). `open http://…/setup` launched the default browser.
- **Profile → secret → activate → GET /fabric → Test:** PUT a `my-rig` profile whose llm endpoint
  references keyRef `my-key` and points at a fake reachable server → 200; PUT the secret value → 200,
  `GET /fabric/secrets` lists `[{"ref":"my-key"}]` (name only); activate → 200; `GET /fabric` now
  returns that map with `auth.keyRef` and **the secret value does NOT appear anywhere** in it; the
  first-run banner is **gone** now the llm slot is non-empty; `POST /fabric/test` → `{ ok: true,
  latencyMs: 9 }`.
- **Honest failures:** unreachable → `{ ok:false, error:"fetch failed" }`; unresolved keyRef →
  `{ ok:false, error:'unresolved secret keyRef "ghost"', hint:"no value stored…" }`; **delete the
  active profile → 409** guarded; clone → 200; `?edit=my-rig-2` opens that profile in the editor.
- **Could not automate** (documented ceiling, as prior client slices): a real tray *click* and the
  visual look of the served page in the browser — the tray change is verified via its pure tests and
  the `open` launch; every API link the page drives is exercised above.

### Deferred (out of this slice, by scope)
- Auth on /setup (localhost-only posture — P7); the workbench proper (P4); surface/mode/dial editors +
  palette (P6); an embedded-webview settings UI in the client; cloud endpoint kinds; macOS Keychain;
  model catalogs/downloading; live tok/s measurement on the Test button (it pings; tok/s is echoed
  from the last tools/bench measurement); any change to invoke/profile/secret semantics (slice (a)).
