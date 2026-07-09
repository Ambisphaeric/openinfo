# Phase 3 Notes

Records decisions/deviations as each Phase 3 slice lands, in the PHASE2-NOTES style.

## Slice: Retroactive session reroute — the correction loop (SHIPPED BEFORE THE DETECTOR)

Phase 3 begins with its safety net, not its magic. IMPLEMENTATION §3's risk register is explicit:
"Router mis-attribution poisons workspace DBs → Evidence on every session + one-click retroactive
reroute shipped same phase." So this slice builds the correction (`POST /sessions/:id/reroute`, moving
a session between workspace DBs) BEFORE the context-switch detector that will make the mistakes — the
correction loop must exist before the mistakes do. The detector, calendar/repo/voice attribution
signals, cross-workspace entity edges, canon, and pins are all still ahead (out of this slice).

### Contracts — one payload defined, one event added (both additive)
- **`RerouteRequest { toWorkspaceId }`** (api/payloads.ts): the `POST /sessions/:id/reroute` body's
  `$id` has been named in the Routes contract since Phase 0 but never defined — a dangling placeholder.
  Defined now (the session is addressed by the route id; its current workspace is read server-side, so
  the caller supplies only the destination — mirroring StartSessionRequest's "invent no server-owned
  field" precedent). Seeded `rerouteRequest.move.json`, mapped in contracts.test.
- **`session.rerouted: Session`** added to the Events contract. **Decision: a NEW event, not the
  existing `session.switched`.** The sessions slice deliberately left `session.switched` unused as
  "router territory (P3) — a *detected* context switch." A reroute is not a detected switch: it is the
  *retroactive user correction* of a past attribution. They differ in trigger (a user click vs the
  detector firing), temporality (a completed, ended span vs the now-current session), and — decisively
  — teaching-loop meaning: `session.switched` will be the router's *action*, `session.rerouted` is the
  labeled *"the router was wrong here"* correction signal (IMPLEMENTATION §4 teaching loop). Overloading
  one event would blind a P3 consumer to that distinction. This mirrors the sessions slice's own
  discipline (it emitted two honest lifecycle events rather than fabricating a switch): `session.switched`
  stays genuinely unused until the detector lands. The engine bus `EngineEvents` gains the same key and
  a WS broadcast, exactly like the other session events.
- No record schema changed shape. `Session.reroutedFrom` and `AttributionEvidence` (with its `manual`
  kind) have existed since Phase 0 — the slice fills them in, it does not touch them.

### Store — `moveSession(sessionId, from, to)`, the ONLY DB-handle holder moving a session
`route/` asks store to move a session (dependency rule 2: only store/ opens DB handles). moveSession
transactionally relocates the session record + everything keyed to it (distillates, moments, drafts)
from the source workspace's sqlite file to the destination's, stamps `reroutedFrom`, and re-aggregates
the workspace-level entities (below).

**The transactional guarantee + crash story (v0, honest).** sqlite transactions are per-file, so a move
across two DB files *cannot* be one ACID transaction — there is no cross-file commit. The guarantee we
ship instead:
1. Each per-file mutation is atomic (better-sqlite3 `.transaction`): the destination writes commit as
   one unit; the source subtraction + deletes commit as one unit.
2. **Ordering is destination-first, source-second.** The moved data exists in the destination before it
   is removed from the source — a crash never loses records, at worst it duplicates them.
3. **Every step is idempotent.** Record copies are insert-or-replace by id; entity contributions union
   into the destination and subtract from the source *by distillate id* (a set membership test, not an
   increment), so re-applying them changes nothing.

**Detection + resolution of the crash-between-phases duplicate.** A crash after the destination commit
but before the source deletes leaves the session in BOTH workspaces. This is *detectable*:
`store.sessionWorkspaces(id)` returns every workspace whose DB holds the id — length > 1 is the
duplicate. It is *resolved* by re-running the same `moveSession(id, from, to)`: the destination re-write
is a no-op (insert-or-replace + set-union), and the source delete completes — converging to exactly one
copy in the destination. A re-run of an *already-completed* move is also a no-op (source empty ⇒ it
returns the destination session). In the product this re-run is simply the user clicking reroute again;
no separate reconciler is needed in v0. (`stopAfterCopy` is a test-only seam that stages the crash.)

**Same-workspace move** is refused at both layers: the route returns 400 (already there), and the store
throws defensively.

### Entity semantics (the hard part — v0 kept honest, small, and deterministic)
Moments carry entity `refs`; entities aggregate mentions/provenance across *many* sessions, so they are
not session-keyed and cannot simply move with the session. There is no llm at reroute time, so we cannot
re-run same-pass linking against the destination. The v0 rules, all deterministic and tested:

- **Moved moments keep their text; their `refs` are REMAPPED or DROPPED.** A ref is remapped to the
  destination entity of the same `(kind, normalized-name)` when the moved session actually contributed
  that entity (so it was upserted into the destination first, below); otherwise the ref is DROPPED. The
  documented wart: a moved moment's ref to an entity that STAYS in the source (mentioned only by other
  sessions) has no honest destination target, so it is dropped — we never fabricate a destination entity
  from one that isn't moving. In index-v0 practice refs point to entities the session itself mentioned
  (same-pass linking), so they remap cleanly; the drop is the safety net that cannot corrupt the
  destination.
- **The moved session's entity CONTRIBUTIONS = source entities whose provenance names a moved
  distillate** (provenance entries carry `distillateId`). Each contribution is UPSERTED into the
  destination by `(kind, normalized-name)` — merging into an existing destination entity or creating a
  fresh one — unioning provenance **by distillateId** (idempotent, no double-count on re-run) and
  unioning the surviving moment refs. `mentions` grows by the number of newly-added distillate entries.
  This reuses index-v0's exact normalized-name policy (trim/lowercase/collapse-whitespace, same-kind).
- **In the SOURCE, each such entity's moved-distillate provenance is SUBTRACTED**: those provenance
  entries are removed, `mentions` decremented by that count, moved moment refs stripped. **An entity that
  reaches ZERO mentions is DELETED from the source** (chosen over keep-with-zero). Justification tied to
  the risk register's "cannot silently lie in the source": a zero-mention ghost still appears in
  `/entities` and pollutes counts while asserting evidence the source no longer holds — deletion is the
  honest zero. An entity shared with another session survives at its reduced count (tested: Mercury,
  mentioned by the moved session and one other, ends at mentions 1 in each workspace). Entities the moved
  session never touched are left untouched (their provenance names no moved distillate).

Accepted v0 warts (documented, none can corrupt the destination): dropped cross-session refs (above);
name-normalized matching inherits index-v0's fuzzy/coreference blind spots (a "Dana C." vs "Dana Cruz"
split, a same-name-different-referent collision) — reroute does not make these worse, it moves entities
under the same key the index already uses; canon/reference-merging (still P3, later slice) is the
designed fix. Entities predating the index (no provenance) are never subtracted — nothing ties them to a
moved distillate.

### Live-session policy — 409, ended sessions only in v0
Rerouting the LIVE (unended) session is **rejected with 409**. A live session has in-flight capture/drain
state: raw chunks are still spooling and distillates are still being written into the *source* DB. Moving
it would race the drain writing distillates into a workspace the session just left, re-creating the very
duplicate/orphan the move is meant to avoid — and the correction loop's job is to fix a *completed*
mis-attribution, which is inherently a past, ended span. The user ends the session, then reroutes. (This
is also why the guard lives in route/ policy, not the store: the store move itself is agnostic to
liveness; the *product rule* is "correct finished spans".)

### Attribution evidence groundwork — append, never replace
On success the route APPENDS a `{ kind: 'manual', detail: 'rerouted from workspace <from> by user',
weight: 1 }` entry to the moved session's `attribution.evidence` (the `AttributionEvidence` shape already
supports this: an array of typed evidence). It does NOT replace the existing evidence — when the detector
lands, its automatic evidence (e.g. a `window`-kind entry at weight 0.6) stays on the record beside the
manual correction, so the teaching loop can read "router said X (0.6), user corrected to Y (manual,
1.0)". **Confidence becomes 1.0**: a manual correction is the authoritative attribution — the user
asserted it, so nothing outranks it. Stamping `reroutedFrom` is the store's job (it is intrinsic move
metadata written inside the atomic destination write); appending attribution is route policy (mirroring
how startSession stamps its `manual` evidence at the route). The attribution re-save is a second,
idempotent write into the destination — a crash before it leaves the session correctly relocated but
without the manual note (reroutedFrom, the correctness-critical stamp, is already in the atomic move);
acceptable for v0.

### Tests (node:test, engine style) — 8 new, all green
Store (`store/reroute.test.ts`, 6): move round-trip (session + distillates + moments + drafts present in
destination with rewritten workspaceId, absent in source, reroutedFrom stamped); ref remap to a
destination entity + drop of a stay-in-source ref; source subtraction with delete-at-zero and a shared
entity surviving reduced; destination merge into an existing entity (no duplicate); idempotent re-run
after a `stopAfterCopy` crash (duplicate detected, then converged, no double-count); same-workspace
reject. HTTP e2e (`api/http.test.ts`, 2): the move round-trip over HTTP across two on-disk workspace DBs
with the `session.rerouted` event asserted, and the full 404 / 400-same / 400-unknown / 409-live guard
matrix.

### Deferred (out of this slice, by scope — the detector slice picks these up)
- The context-switch detector itself (`route/detector.ts`), which needs client focus capture (window
  title + repo path), plus calendar/voice attribution signals and `route/attribute.ts` writing evidence
  on sessions at creation — the next slice. It will EMIT `session.switched` (left unused here) and will
  read `session.rerouted` as a teaching-loop correction signal.
- Multi-workspace CREATION flows beyond what tests exercise (workspaces already exist on demand via the
  store's `ensureWorkspace`); a client/HUD one-click reroute surface (the API is the slice — the button
  rides a later client pass); cross-workspace entity graph edges, canon, pins/ingestion, envelope math.
- Durable auto-reconciliation of a crash-duplicate (v0 relies on the idempotent re-click); a background
  sweep using `sessionWorkspaces()` is the obvious future home if crashes ever prove common.

## Slice: Context-switch detector — the day segments itself (v0: window title + repo path)

The router the reroute loop was built to correct. IMPLEMENTATION §3: "Context-switch detection (window
title + repo path + calendar + voice presence), attribution evidence on every session." v0 ships the
window-title + repo-path signals; calendar and voice-presence are later slices (they add signal SOURCES,
not new machinery). Built as a MAIN-tree half against a contracts seam the concurrent client
focus-capture half builds against.

### Contracts — the focus seam (two commits, additive)
- **`CaptureSource` gains `'focus'`** and **`FocusSignal { app, windowTitle?, repoPath? }`** (api/payloads.ts,
  the client seam, landed first). Focus signals travel as ORDINARY CaptureChunks — `source: 'focus'`,
  `encoding: 'utf8'`, `contentType: 'application/json'`, `data` = JSON.stringify(FocusSignal) — so the
  client, spool, and drain need no new transport; the detector decodes at the drain. Machine-global
  foreground context, never a transcript. Validated `captureChunk.focus` + `focusSignal` examples.
- **`WorkspaceHints { workspaceId, patterns: AttributionPattern[] }`** and **`AttributionPattern { field:
  'repoPath'|'windowTitle'|'app', contains?, prefix?, weight }`** (config/hints.ts, engine-side, second
  commit — the client never touches hints). Also exports `AttributionEvidence`'s static type and the
  **`route.detect`** flag example. Validated `workspaceHints.sales` example.

### The hints document (attribution config as data)
A versioned per-workspace document (store kind `workspace-hints`, keyed by workspaceId), consistent with
modes/registers/act templates — editable through the same document mechanism. A pattern names a
FocusSignal field and a case-insensitive matcher (`contains` and/or `prefix`); its `weight` (a
Confidence) rides straight onto the AttributionEvidence entry a switch stamps (field→kind: repoPath→
`repo`, windowTitle/app→`window` — the existing AttributionEvidence kinds; there is no `app` kind, so an
app match is `window`). **Seeding decision: only an EMPTY hints doc for `default` is seeded** (`patterns:
[]`, matches nothing). There is deliberately **no permissive fallback** — a catch-all that captured every
signal would attribute everything to `default` and defeat detection. **Unmatched signals therefore take
NO action** (documented). Real hints are added per workspace via the document store; an HTTP hints-editing
route is a later slice ("the API is the slice" discipline, as with reroute's client button).

### The detector (`route/detector.ts`, pure) — sustain-window semantics
`detectSwitch(signals, hints, currentWorkspaceId, config)` over an ordered stream of timed FocusSignals →
`{ decision: 'stay'|'switch', toWorkspaceId?, evidence: AttributionEvidence[], confidence }`. Deterministic,
unit-tested. The anti-thrash core — a switch fires only when ONE workspace **dominates the trailing
`sustainMs` window**:
- there must be ≥ `sustainMs` of observation (the buffer must span the window) — a brief burst can never
  switch, and a fresh boot watches a full window before auto-starting;
- each windowed signal is attributed to its single best-scoring workspace (a tie or a zero score ⇒
  unattributed, and only dilutes);
- the dominant workspace must own ≥ `dominanceShare` of ALL windowed signals (unattributed/ambiguous
  count against it) AND differ from the current one.
So a brief alt-tab never accrues the share over a full window, and an even split between two workspaces
stays put. **Constants (`DEFAULT_DETECTOR_CONFIG`, the ONLY tuning knobs, all in `route/detector.ts`):
`sustainMs = 90_000`, `dominanceShare = 0.6`, `maxConfidence = 0.9`.** `confidence` is the winner's window
share capped at `maxConfidence` — **always < 1**, because a DETECTED attribution is never as certain as a
manual one (reroute stamps 1.0). `evidence` is the winner's distinct matched hints across the window.

### Wiring (`route/attribute.ts` — the Attributor; wired in the drain)
Focus signals are **machine-global**, sessions are **per-workspace**, so the Attributor holds ONE rolling
in-memory buffer (pruned to 2× the sustain window) and evaluates against **ALL** workspaces' hints — not
per-workspace. It runs in the queue drain behind **`route.detect` (OFF, engine)**, read per-drain like the
`distill.*` siblings, and **independently of `distill.enabled`** (focus is routing context, not content to
distill). "current" = the most-recently-started live session across all workspaces. Actions when a switch
fires:
- **No live session anywhere + sustained match → auto-START** a session in the matched workspace
  (`session.started`), attribution = the detector's evidence at confidence < 1, NO manual entry.
- **Live session in W1 + sustained match for W2 → auto-END W1** (`session.ended`), **START in W2**
  (`session.started`), **emit `session.switched`** (the STARTED session — the router's action). Mirrors
  the manual-start auto-end-on-start rule; defensively also ends any live session already in the
  destination (one-live-per-workspace).
Every auto-started session carries the evidence trail, so the risk-register invariant holds (evidence on
every session; a detected attribution never outranks a manual one). **The teaching-loop hook:**
`session.rerouted` (last slice) is the labeled correction of exactly these auto-attributions — "the router
was wrong here" (IMPLEMENTATION §4). Nothing new was needed on the reroute path.

### Distill hygiene (hard requirement) — focus never becomes content
Focus chunks are `utf8`, so they would pass the distiller's `isText` filter. Enforced in two places:
(1) the drain routes `source:'focus'` chunks to the detector, not the distiller; (2) the distiller's
`isText` now **explicitly excludes** focus (by `source` AND `contentType application/json`). A focus signal
is evidence for WHERE a session belongs, never content IN one. Proven by a mixed-spool test: speech + focus
in one batch distills only the speech (transcript contains neither the focus title nor its JSON), while the
same batch still yields the focus signal for the detector.

### Tests (node:test) — all green
`route/detector.test.ts` (8: dominance→switch, blip-tolerance, ambiguity→stay, no-match→stay, sub-sustain→
stay, switch-away-from-live, dominant==current→stay, empty→stay); `route/hints.test.ts` (2: empty-default
seed + idempotent, put/version/get/all); `route/attribute.test.ts` (3: auto-start with evidence & no manual
entry, live-switch emits ended+started+switched, ambiguous→no-op); `distill/hygiene.test.ts` (1: mixed
spool); `api/http.test.ts` drain e2e (4: auto-start with evidence through the real spool, sustained switch
auto-ends + emits `session.switched`, flag OFF does nothing, sub-sustain burst does nothing). Engine
`route.detect` live checks used port 8914 only.

### Rule-7 check (definition of done)
The slice adds the `route.detect` **flag** and one flagged behavior; it adds NO new HTTP route (focus rides
the existing `POST /capture/:source`) and no new recipe-touched surface. A flag has no `skills/`-rail or
CONTRIBUTING recipe to keep in sync (recipes cover block types / watchers / fabric runtimes), so no
`skills/` or recipe edit is required. Verified: `skills/add-a-block` references the `distill.*` data-source
flags, not a flag registry — untouched.

### Deferred (later slices extend this)
- **Calendar + voice-presence signals**: additional CaptureSources feeding the SAME detector/hints —
  calendar attendance/title matches and "is the user speaking" presence become new signal kinds
  (AttributionEvidence already has `calendar`/`voice` kinds) and/or new hint fields; the sustain-window
  machinery and the auto-start/switch policy are unchanged.
- An HTTP/HUD surface to EDIT hints (v0 edits at the store layer); per-user/per-context hint overrides
  (flags already layer this way). Cross-workspace entity graph, canon, pins — still ahead.

## Slice: Client focus capture — what the detector sees (SHIPPED)

The detector (concurrent engine slice) needs to know which app/window/repo is in front. This slice is
the CLIENT half: a main-process poller that samples the frontmost window and emits `FocusSignal`s onto
the existing capture seam. It builds ONLY the emission — the detector/attribution logic, calendar/voice
signals, and the engine-side exclusion of focus from transcripts are the other agent's territory. Domain:
`apps/client/` only. The contract seam (`CaptureSource` gains `'focus'`; `FocusSignal { app, windowTitle?,
repoPath? }`; focus travels as an ordinary utf8/JSON CaptureChunk) landed first as the other agent's
`feat(contracts): focus capture source + FocusSignal`; this slice merged it and built against it.

### A DEDICATED poller, not CaptureController — the "rhymes-but-differs" call, decided the other way
System-audio reused CaptureController because it genuinely rhymes with mic (same lifecycle, chunk shape,
EngineLink). Focus does NOT. It is main-process (no hidden renderer, no getUserMedia, no MediaRecorder),
low-rate (one sample every ~3s vs a continuous stream), session-INDEPENDENT (it runs to DETECT context,
including when no session is live — it is what STARTS sessions), and gated on a different axis entirely
(an engine flag + a local opt-out, not the session lifecycle). CaptureController's whole shape —
permission→starting→capturing, per-session context, final-segment flush, silence honesty — is
audio-specific and would be dead weight. So `focus-poller.ts` is a small dedicated state machine. It
still honors the house pattern: pure + electron-free (the whole gating/dedupe/throttle machine is
asserted headless), with the one OS edge (the osascript read) isolated in `shell.ts` and out of CI.

### The osascript poller vs a native module — fewest deps + the honest TCC story wins
Chose **`osascript` / System Events** polling for v0 over (b) a native module (active-win lineage) and
(c) Electron-only APIs. (c) can't see OTHER apps (Electron only knows its own windows) — insufficient.
(b) would add a native dependency whose prebuilds must be trusted for Electron 38 / macOS 26, AND window
TITLES through it need Screen Recording TCC — more surface, more to vet, for a v0. (a) adds ZERO
dependencies; the honest cost is an **Accessibility** grant (System Settings → Privacy & Security →
Accessibility → enable the running app). The reader returns `undefined` when denied/failing, and the
poller keeps its last state and emits nothing (no crash, no partial signal). FUTURE UPGRADE: a reviewed
native reader (CoreGraphics/Accessibility) drops in behind the same `sample()` seam — swapping only HOW
the frontmost window is read, not the poller/redaction/gating around it (the same "swap only how the
stream opens" discipline the system-audio slice set up for its future CoreAudio tap).

### Cadence / dedupe / throttle
- **Cadence:** `FOCUS_POLL_INTERVAL_MS = 3000` — a documented constant. Context, not keystrokes; a few
  seconds' latency on "you switched to Slack" is invisible and keeps the poll cheap. On activate it also
  does an immediate first tick so the current window is announced without waiting a full interval.
- **Dedupe:** emit ONLY on change. The dedupe key is `app + redacted windowTitle + repoPath`; two
  consecutive identical samples emit nothing. Keying off the REDACTED signal means a change that differs
  only in a scrubbed-away secret does not spuriously re-emit.
- **Throttle:** `FOCUS_MIN_EMIT_INTERVAL_MS = 1000` caps emissions even when the window keeps changing
  (a title ticking a progress counter, an alt-tab flurry). A throttled change is NOT recorded as "last
  seen", so it is re-evaluated and emitted on the next eligible tick — belt-and-braces over the
  fixed-cadence poll + on-change dedupe (which already bound emission to ≤1 per cadence per change).

### repoPath v0 — from the window TITLE, an ordered rule list, never shelling into other processes
`REPO_RULES` (justified per the device-match.ts precedent: a tiny client-local heuristic that never
crosses the seam) parse a repo identifier from KNOWN dev-app titles: VS Code / Cursor expose the
workspace ROOT NAME as the last em-dash segment ("focus.ts — openinfo" → "openinfo"); Terminal / iTerm
expose a path token ("~/openinfo/apps/client") or the leading cwd basename. We NEVER shell out to inspect
another process's cwd (far more privilege; a native concern later). **WART, stated:** a title only
exposes what the app put there, so v0 `repoPath` is a best-effort IDENTIFIER — often a bare project name
(editors), sometimes a real path (path-showing shells) — good enough for the detector to match a session
to a repo, but NOT a guaranteed absolute git root. A `git -C` / native resolution is the future. Rules
return undefined rather than guess wildly (a lone editor segment yields nothing).

### Privacy gating — TWO gates, and "off" means OFF (not poll-and-drop)
Window titles are sensitive, so polling runs ONLY when BOTH gates are open:
1. **Engine `route.detect` flag** (workspace opt-in to context detection). Read from `GET /flags` on
   connect and re-checked on the `flag.changed` WS event. The flag's `default` IS its effective value
   (mirrors the engine's `isFlagEnabled`, which reads `default`); a missing flag reads OFF.
2. **Client-local `OPENINFO_FOCUS` opt-out** (default ON) — CONFIG, not a flag, for the identical reason
   `micEnabled` is: it is how the client reads its OWN machine, never touches the engine/store, and
   whether focus MEANS anything is already gated engine-side by `route.detect`.

When either gate is off the poller's timer is CLEARED — no polling at all, and the dedupe memory is
wiped so a later re-enable re-announces the current context. This is the whole point of the dedicated
machine: privacy is a structural invariant (`reconcile()`), not a drop-at-emit afterthought. Also a
best-effort `redactTitle` scrubs obvious secrets (provider token prefixes, bearer tokens, emails,
secret-ish key=value, long hex) from any title we DO emit — a conservative v0 constant, warts stated: a
novel token format sails through and it can over-redact (an email in a legit title becomes `[redacted]`).
We err toward redaction; the real fix (per-app allow/deny) is a later slice.

### Emission — session-less, and the spool policy: focus is EPHEMERAL, never spooled
Focus chunks carry `source: 'focus'`, `encoding: 'utf8'`, `contentType: 'application/json'`,
`data = JSON.stringify(FocusSignal)`. **Session-less by design:** focus flows OUTSIDE sessions (it is
what starts them), so there is usually no live session. The CaptureChunk contract still requires a
non-empty `sessionId`, and the engine's `/capture` route validates the SHAPE but does not verify the
session exists (confirmed by reading `captureChunk` in `api/http.ts`; `Id` is just `minLength: 1`), so a
stable sentinel (`FOCUS_SESSION_SENTINEL = 'focus-context'`) satisfies the seam honestly — the detector
routes focus by `source`, never by this id. (Same move sim.ts made: supply a value the route accepts
rather than reworking the seam.) Chunk ids fold a per-run id + sequence so they never collide across runs
without a session to key off.

**Spool policy — DECIDED: don't spool focus.** EngineLink.capture always spools on failure (right for
audio: a lost utterance is real data loss). Focus is the opposite — a "which window was focused 10
minutes ago" replayed from a spool when the engine returns is NOISE, not signal, and the next poll
re-announces the current context anyway. So this slice added `EngineLink.captureEphemeral` (client-side,
in-domain): POST-and-drop, no spool, never throws. Focus is fire-and-forget.

### Tray honesty (minimal)
When focus polling is active the tray TOOLTIP gains a quiet "· watching context" note (independent of
session liveness — focus runs session-less), and nothing when off. No status-header change, no new menu
items (per scope).

### Tests (node:test, client style) — 34 new, all green
`focus.test.ts` (13): title→repoPath per app (editor root name, terminal path/basename, app-name-suffix
strip, non-dev apps yield nothing, case-insensitive app match); redaction of each secret shape + an
untouched ordinary title; buildFocusSignal (redaction, repoPath, optional-field omission, never emitting
a raw secret); dedupe key; chunk shaping (source/contentType/utf8 JSON payload round-trip, sentinel
sessionId, collision-free ids). `focus-poller.test.ts` (11): `detectEnabledFrom` flag read; no-poll-when-
off; flag-ON immediate announce; dedupe; change→new sequence; burst throttle defer-then-emit; unreadable
sample keeps state; flag-off-mid-run stops + clears dedupe; local opt-out beats the flag; re-enable
re-announces. `config.test.ts` (+1): `OPENINFO_FOCUS` opt-out. `tray-menu.test.ts` (+1): the tooltip
note, session-independent. The osascript read + shell wiring stay untested-by-CI (thin electron edge,
like the capture renderer). Full `apps/client` suite: 111 tests green.

### Live verification (this Mac, darwin 25.3, engine on :8915, killed after)
Started the engine on :8915, `PUT /flags/route.detect {default:true}`, then drove the REAL compiled
`FocusPoller` + `EngineLink.captureEphemeral` (with the same osascript reader shell.ts uses) against it
while switching the frontmost app via `osascript ... activate`. Observed over the engine's WS
`capture.received` feed: flag OFF → a tick emitted NOTHING; enabling → immediate emit of the frontmost
app; switching to Finder → a new `{app:"Finder"}` chunk (sequence 2); the same app again → DEDUPED (no
emit); switching to Ghostty → `{app:"ghostty"}` (sequence 3). All three arrived at `/capture/focus` with
correct source/contentType/JSON payload; engine log clean.

**The exact wall:** window TITLES came back EMPTY via System Events for every app available in this
automation context (Finder, Ghostty, Activity Monitor, TextEdit) — only the app NAME flowed. Accessibility
IS granted (app names read fine); the empty titles are the apps not exposing an AX front-window title in
this context (and on some apps titles need a Screen Recording grant too). So the title→redaction→repoPath
path is proven by the 34 unit tests, not the live wall; app-name focus signals are proven live end-to-end.
Human grant to get titles in real use: System Settings → Privacy & Security → **Accessibility** (enable
the app), plus **Screen Recording** for titles on apps that gate them.

### What the detector agent's seam made awkward (report, did not diverge)
`route.detect` is NOT a SEEDED default flag yet (the detector slice will add it to the engine's
`ensureDefaultFlags`). Consequence: `GET /flags` only enumerates the seeded defaults (with overrides), so
a `PUT /flags/route.detect` is stored and BROADCAST (the `flag.changed` WS event fires correctly) but is
INVISIBLE to `GET /flags`. My client therefore learns the flag via the `flag.changed` event fine, but the
CONNECT-time seed (`detectEnabledFrom(await engineLink.flags())`) can't see it until it is seeded — a
client that starts while `route.detect` is already on stays idle until the next flip. The client code is
correct against the contract; the fix is engine-side and in the detector agent's domain: **seed
`route.detect` in `ensureDefaultFlags`** and the connect-time gate works too. Not worked around here (no
engine changes in scope). No other seam friction — focus riding the ordinary CaptureChunk (utf8/JSON) meant
the client, spool, and `/capture` route needed zero new transport.

## Slice: Assembled first-run — a packaged, self-identifying .app + permission UX + first-run /setup (convergence on P2/P3)

Convergence work, not a new phase feature: the Phase-2/3 code was complete but nobody owned the ASSEMBLED
experience — launch → get asked for permissions PROPERLY → configured → HUD alive. The user's audit found
"the menu bar app doesnt request mic permissions." Root cause (confirmed): the shell shipped only as an
UNSIGNED `electron .` dev binary, which has **no bundle identity**, so macOS attributes its TCC requests to
the LAUNCHING process (Terminal/launchd) — the app's own dialogs never appear (the /setup page prompts fine
because the browser has a proper TCC identity). This slice gives the client a real, ad-hoc-signed .app that
owns its identity, plus the tray affordances that make each permission wall visible and fixable. **HUD
customization / the surface editor is a SEPARATE upcoming slice — untouched here (no `engine/src/surfaces/`,
no capture/focus logic changes beyond guidance).**

### Packaging — `@electron/packager`, ad-hoc `codesign -s -` (NOT electron-builder)
`pnpm --filter @openinfo/client package` (build + `scripts/package.mjs`) produces a real double-clickable
`release/openinfo-darwin-arm64/openinfo.app` (arm64) and ad-hoc codesigns it. Chose `@electron/packager`
over electron-builder: we want an unsigned/ad-hoc DEV app, not a notarized distributable — packager makes
exactly that bundle with far less machinery (no installer, no auto-update, no notarization — all out of
scope). CI is untouched: `pnpm -r build` / `-r test` never call this; packaging is an explicit script.
- **Info.plist keys (via `extendInfo`), verified with `plutil`/PlistBuddy on the built app:**
  - `NSMicrophoneUsageDescription` — honest, session-gated copy ("listens only while a session is live, to
    transcribe locally … No session, no listening").
  - `NSLocalNetworkUsageDescription` — "reaches model servers and engines on your local network (LM Studio,
    Ollama, or an engine on another machine)".
  - `LSUIElement: true` — menu-bar-only agent (matches the runtime `app.dock.hide()`; avoids a Dock flash).
  - **Accessibility has NO plist key** — it is granted per-app in System Settings → Privacy & Security →
    Accessibility, not declared in Info.plist. Documented rather than invented (the focus poller's
    `osascript`/System Events read is what needs it). Some apps additionally gate window TITLES behind
    Screen Recording; Accessibility is the primary grant and the reliable floor.
- **Signing story + the rebuild-reprompt caveat (honest):** `codesign --force --deep --sign - --timestamp=none`
  gives an **ad-hoc** identity (`Signature=adhoc`, `Identifier=ai.openinfo.client`, verified with
  `codesign -dv`). The whole point: a bundle identity means macOS asks for mic / Local Network under the
  APP's name and the Accessibility grant sticks to the bundle. **Caveat:** an ad-hoc identity CHANGES on
  every rebuild, so macOS treats each rebuilt app as new and RE-PROMPTS for permissions after a rebuild
  (prior grants may need re-approving). **Upgrade path:** a stable self-signed codesigning cert
  (`security` + a self-signed identity, then `--sign "openinfo dev"`) keeps a constant identity across
  rebuilds without paying for a Developer ID — recorded in `scripts/package.mjs` and here.
- **Bundle is asar-packed (packager default), payload verified lean:** only `package.json` +
  `hud.html`/`capture.html` + compiled `dist/` (main + preloads); NO `node_modules` (the sole workspace dep
  `@openinfo/contracts` is **type-only** at the client seam, so nothing is required at runtime), NO `src`,
  NO `*.test.js` (65 entries). `main` = `dist/main/shell.js`. `productName: "openinfo"` gives a clean
  userData dir (`~/Library/Application Support/openinfo/`) instead of the raw package name.

### Packaged-app config story — `~/.openinfo/client.json`, env still wins
A double-clicked .app inherits no env, so `resolveShellConfig` now merges **env > `~/.openinfo/client.json`
> built-in defaults** (config.ts). An explicit env var always wins (so a launch can still override with
`OPENINFO_ENGINE_URL`), the file supplies packaged defaults (engineUrl/workspace/modeId/surfaceId + the
mic/systemAudio/focus toggles), and the built-ins (localhost:8787, meeting mode) are the floor. The file is
OPTIONAL and best-effort — absent/unreadable/malformed is ignored. The merge + validation are pure (headless
tests); the file read is the one thin IO edge (beside `~/.openinfo/data`, the engine's dir).

### Permission UX — visible and fixable from the tray (no popups; the tray IS the surface)
- **Mic — timing unchanged, DENIAL now actionable.** The request still fires on the FIRST session start
  (`askForMediaAccess` via the shared, in-flight-deduped audio permission — verified in the live run:
  starting a session logged `mic access status before request: not-determined`, i.e. the packaged app
  reaches its OWN dialog). On denial (`micState === 'denied'`) the tray shows a clickable **"⚠ Microphone
  blocked — Open Settings…"** item opening `x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone`.
  An unsigned/ad-hoc dev app cannot re-fire a denied TCC prompt, so re-granting in Settings is the only
  path — the item takes the user straight there.
- **Local Network — honest hint, no fake detection.** When the configured engine is non-loopback and
  unreachable, the tray leads with **"⚠ engine unreachable — <url>"** and the tooltip appends
  **"check Local Network permission?"**. This is a HINT, never a claim: you cannot query Local Network TCC
  state, so we never assert LN is the cause. First-boot "connecting…" is distinguished from a
  tried-and-failed engine (`engineTried`). No "Start engine" affordance (out of scope) — just honest copy +
  the URL it tried. The app's first LAN fetch still triggers the OS prompt for a GUI app (nothing swallows
  it). (ARCHITECTURE's platform note: an engine on a headless box must run from a GUI-domain LaunchAgent,
  not ssh-orphaned, or its LAN probes are silently denied — that is the ENGINE side, unchanged here.)
- **Accessibility — guidance only when context detection is on but title-less.** A
  `ContextHealthTracker` (pure, tested) watches focus-sample outcomes: while `route.detect` is on and the
  poller active, if the `osascript` read fails or returns an app with no window title and we have NEVER
  seen a title, the tray shows **"Grant Accessibility for context detection…"** opening the Accessibility
  pane. Derived from real sample outcomes (no fake detection); clears the moment any title arrives; resets
  when watching stops. The wrapper only OBSERVES — it never changes what focus emits.
- **Deep links verified on THIS Mac:** `open "x-apple.systempreferences:…Privacy_Microphone"` and
  `…Privacy_Accessibility` both opened the correct pane (exit 0) on macOS 26.

### First-run assembly — open /setup ONCE, then never nag
On launch, once the engine is reached AND its llm slot is empty (`needsModelSetup`), the shell opens
`/setup` in the browser so a new user lands on onboarding — at most ONCE. A `firstRunShownAt` timestamp is
persisted client-local (`first-run.json` under userData, mirroring window-store); once set it never
auto-opens again (the ⚠ "Set up models…" tray prominence stays as the always-available nudge). Engine
unreachable at launch ⇒ open nothing (there is no /setup to show) — the tray leads with the unreachable
state. The once-only decision is pure/tested; the shell guards it with a process-level `firstRunChecked`
flag over the two seed calls (whenReady + WS reconnect). **Live-verified:** first launch against a fresh
engine (empty llm slot) logged `first run — llm slot empty, opening /setup once`; a second launch with the
timestamp present did NOT re-open; an unreachable-engine launch opened nothing and logged the reach failure.

### Tests (client, headless/pure — +25: 111 → 136 total, all green)
- `config.test.ts` (+9): file supplies defaults; env > file > defaults precedence (url, host/port compose,
  strings, capture toggles); trailing-slash trim; `parseClientConfigFile` keeps valid / drops junk;
  `loadClientConfigFile` temp-file round-trip + missing/malformed swallow; `clientConfigPath`.
- `permission-help.test.ts` (4): the three `x-apple.systempreferences` Privacy_* URLs; `settingsUrlFor`
  mapping; `isLanEngine` loopback-vs-LAN + unparseable.
- `context-health.test.ts` (4): the pure predicate; the tracker hinting after a title-less sample, clearing
  on a title, resetting on inactive, ignoring observations while inactive.
- `first-run.test.ts` (5): `shouldOpenSetup` truth table (reachable+empty+unshown ⇒ once; suppressed when
  shown/model-exists/unreachable/unknown); `parseFirstRunState`; store round-trip + never-shown-empty.
- `tray-menu.test.ts` (+5): engine-unreachable vs connecting + the URL; LAN hint present/absent; the mic and
  accessibility fix-it items appear only in their state with the right command.
The electron edge (`shell.ts`, `scripts/package.mjs`) stays untested-by-CI as established.

### Live verification (this Mac, darwin 25.3/macOS 26, Electron 38.8.6; engine on :8917, killed after; 8787/:1234/:11434 left alone)
- Built the package for real; `codesign -dv` → `Signature=adhoc`, `Identifier=ai.openinfo.client`;
  PlistBuddy confirmed both usage-description keys + LSUIElement; asar payload verified lean (no
  node_modules/src/tests).
- Launched the packaged binary directly (`…/Contents/MacOS/openinfo`) against a fresh engine (empty llm
  slot): logs showed `HUD window created — content-protection: ON`, `shortcut CommandOrControl+\ …
  registered`, `first run — llm slot empty, opening /setup once`, and — after a `POST /sessions` flipped
  the tray live — `mic access status before request: not-determined` (the app REACHES its own mic dialog).
- Second launch (timestamp persisted): NO first-run re-open. Unreachable launch: no /setup, reach failure
  logged. Deep links opened the right Settings panes via `open`.
- **What a human still must click** (the TCC dialogs themselves need a person; no code can auto-approve):
  1. On first session start, the **Microphone** dialog → **Allow** (or later, if denied, the tray's
     "Microphone blocked" item → toggle the app on in the Microphone pane).
  2. For a LAN engine, the **Local Network** prompt on first reach → **Allow**.
  3. For window-title context, System Settings → Privacy & Security → **Accessibility** → enable the app
     (and Screen Recording for titles on apps that gate them) — surfaced by the tray's Accessibility item.
  4. Because the identity is ad-hoc, all of the above re-prompt after a `pnpm package` rebuild.

### The exact commands the verifier needs on a remote Mac
```bash
pnpm install && pnpm -r build            # contracts + engine + client
pnpm --filter @openinfo/client package   # → apps/client/release/openinfo-darwin-arm64/openinfo.app (ad-hoc signed)

# point it at an engine (any ONE of):
echo '{"engineUrl":"http://<engine-host>:8787"}' > ~/.openinfo/client.json   # packaged-app default
open apps/client/release/openinfo-darwin-arm64/openinfo.app                   # double-click equivalent
# …or override with env by launching the binary directly (also shows logs):
OPENINFO_ENGINE_URL="http://<engine-host>:8787" \
  apps/client/release/openinfo-darwin-arm64/openinfo.app/Contents/MacOS/openinfo
```
Verify: `codesign -dv <app>` (Signature=adhoc), `plutil -p <app>/Contents/Info.plist | grep -i usage`.

### Rule-7 check (definition of done)
No new HTTP route, no new flag, no new recipe-touched surface (no BlockTypeName, watcher, or fabric
runtime). This slice adds a build script, client-local config, and tray affordances only — so there is no
`skills/` rail or CONTRIBUTING recipe to keep in sync. README (packaged run mode) + CODE_MAP (the new
main/ files) + this note are the paper kept true.

### Deferred (out of this slice, by scope)
- HUD customization / the surface editor (the next slice — `engine/src/surfaces/` untouched here).
- Notarization / distribution / auto-update; a stable self-signed cert (upgrade path documented above);
  Windows/Linux packaging; universal (x64) builds — arm64 only here.
- Changing capture/focus logic beyond the guidance affordances; a real programmatic screenshot check of
  content-protection (still log-asserted, per the shell slice); auto-approving TCC (impossible by design).

## Slice: HUD customization — the surface editor (forms over documents, v0.5)

The user's second direct complaint, after assembled-first-run: **"the hud is not customizable."**
Architecturally it always was — the HUD is `render(surfaceDocument)` with zero hardcoded layout — but
there was no human affordance to edit that document short of hand-writing JSON and PUTting it. This
slice builds the affordance: an engine-served **forms editor** over surface documents. It is v0.5 (forms
over documents), explicitly **NOT** the Phase-6 WYSIWYG/drag-drop editor (still deferred).

### Contracts — one additive route, one additive event
- **`GET /layouts/surfaces` → `Surface[]`** (phase 3): the editor needs to enumerate; only GET-by-id
  existed. Backed by `SurfaceDocuments.list()` (`layouts.latestOfKind('surface')`, the seeded HUD always
  present), mirroring how `GET /fabric/profiles` lists profiles.
- **`surface.updated: Surface`** added to the Events contract (no placeholder to correct). `PUT
  /layouts/surfaces/:id` now publishes it with the SAVED (version-bumped) document → WS, same pattern as
  `fabric.changed`. This is the HUD hot-reload signal. The engine `EngineEvents` gains the key + a WS
  broadcast.
- `surface.custom-full.json` example added (a block with `use`/`actions`/`custom`) — the fields the forms
  editor must preserve on round-trip; validated by contracts.test.

### The GET /modes drift — fixed here
`GET /modes` was named in the Routes contract at phase 2 but the engine never served it (the known
drift). Wired now via `DistillDocuments.modes()` (`latestOfKind('mode')`, the seeded meeting mode always
present), mirroring `GET /registers`. `PUT /modes/:id` stays unimplemented — a mode editor is out of
scope (voice/register/mode editors are P6); only the read the drift promised is served.

### Where the editor lives — /setup?surface=<id>, mirroring the fabric editor's ?edit=<id>
The editor is **engine-served on /setup**, same family as the model-setup page (CODE_MAP homes all model
setup at engine `GET /setup`; a client settings pane was explicitly rejected there, and the user's
remote-engine workflow wants a browser-reachable page). `?surface=<id>` opens the focused HUD-layout
editor exactly as `?edit=<id>` opens a fabric profile; `/setup` itself grows a discoverable **"HUD
layout"** section listing surfaces with edit links + the HUD-default marker. Same discipline as the rest
of setup/: **pure view** (`surface-editor.ts`, node-tested headless) + a **thin browser script**
(`editor-assets.ts`) that composes ONLY the existing surface routes (`GET`/`PUT /layouts/surfaces[/:id]`)
— no new engine capability (the P6 "forms over documents" rule). `type="button"` + `preventDefault`,
`escapeHtml`/`jsonForScript`, mutate-DOM-then-Save.

### Features shipped (tight) vs deferred to P6
Per surface: reorder blocks (↑/↓), toggle `collapsed`, edit `top` (bounded 1–50), set `show`
(always/on-match/manual), remove block, **add block** (a picker over the `BlockTypeName` union derived
from the contract, with a sensible default query per type mirroring the seeded docs — moments→`source
moments session current`, relevant-now→`source relevant-now top 4`, ledger/pins get their future-store
defaults), **rename**, **clone** (PUT a copy under a new slug id — there is no clone endpoint, PUT
creates), and **Save** (PUT; engine bumps version). A collapsed **raw-JSON escape hatch** (textarea +
"Save from JSON") is the cheap out for edits the form can't express. Honest present-but-future notes on
ledger (P4) / pinned-doc / hint (pins, P3) block rows — the same copy style the fabric slots use.
**Deferred to P6:** the WYSIWYG/drag-drop editor, palette/actions editing (beyond preserving them),
custom-block sandbox, and block-query free-form editing beyond `top` (params stay defaults/preserved).

### Round-trip preservation — the editor rebuilds from the embedded base doc
`Block.use`/`actions`/`custom` and `query.params` are NOT form fields, but they MUST survive form edits.
The browser embeds the whole surface as a JSON blob and, on Save, rebuilds the stack by taking each
row's **original block object** (by `data-idx`) and overwriting ONLY the managed fields
(`collapsed`/`top`/`show`); added rows come from the embedded per-type defaults map. So reordering and
tuning `top` never touch the form-invisible fields — proven at the API level (a form-edit round-trip
asserts `use`/`actions`/`custom`/`query.params` intact after reorder + top/collapsed change), the same
way the fabric editor proved local-endpoint preservation. The preserved fields are also **chipped** in
each row so the user knows they survive.

### HUD hot-reload — refetch on surface.updated for THIS surface id
The HUD controller (browser dev entry + Electron shell both use it) subscribes to `surface.updated`; when
one arrives whose `id === this.surfaceId` it **refetches the surface document** and re-renders through the
existing coalescer — a /setup layout edit appears in the floating HUD within ~1s, no restart. Events for
OTHER surfaces are ignored (the HUD renders exactly one). This is distinct from the data-event re-query
path (moment/entity/session events re-hydrate queries; a layout event re-fetches the layout).

### How the HUD picks its surface id now — the minimal honest switch
Previously effectively hardcoded to `surf-openinfo-hud`. Now: `ShellConfig.surfaceId` already resolved
(env `OPENINFO_SURFACE` > `~/.openinfo/client.json` `surfaceId` > default `surf-openinfo-hud`) but was
never passed to the window — the shell now sends it as `?surface=` alongside `?engine=`, and the dev/
browser entry reads `?surface=` (option > URL > default). So "clone a surface, point a HUD at it" works:
clone in the editor, then `OPENINFO_SURFACE=surf-mine` (or the client.json field, or `?surface=surf-mine`
in the browser). Default behaviour unchanged.

### Live verification (engine on :8787, driven headless + curl)
The user scenario end-to-end: opened the editor (`GET /setup?surface=surf-openinfo-hud` → the forms
page), and via the editor's API path collapsed the moments block + dropped relevant-now `top` to 2 and
saved — the PUT bumped the version and a `surface.updated` frame arrived on `/events` carrying the changed
layout (asserted in the e2e; the client hud.test proves the controller refetches + re-renders on exactly
that frame). Cloned to a new surface (PUT a copy under a new id) and confirmed a HUD started with
`?surface=<newid>` fetches that document. Editor rendered in a real browser: dark glass page titled
"openinfo · HUD layout", one row per block (type + preserved-field chips + reorder/remove + collapsed/
top/show controls), an add-block picker, clone/save, and the raw-JSON details.

### Rule-7 check (definition of done)
The `skills/add-a-block` rail is kept true IN this slice's commits: it now points humans at the forms
editor, documents `GET /layouts/surfaces` for enumeration, the `surface.updated` hot-reload, and
clone-by-PUT. No new `BlockTypeName` (the picker reads the existing append-only union), no new flag
(serving/saving a layout is a resource route, consistent with sessions/HUD), no CONTRIBUTING recipe
touched. README (the /setup editor + list route) + CODE_MAP (surface-editor/editor-assets, list()) + this
note are the rest of the paper kept true.

### Tests + status
Green: contracts 45, engine 212, client 139 (one known client-seam TOCTOU flake, passes on rerun).
New coverage: list route + surface.updated emission + GET /modes (http); editor view states / per-block
controls / add-block defaults per type / future-store notes / clone+save affordances / list marking
(surface-editor); editor HTML served + 404 + round-trip preservation of use/actions/custom (http);
surface.updated on the WS (http e2e); HUD reload-on-event for its id + ignore-other-ids + configured
surface-id selection (client hud).

### Deferred (out of this slice, by scope)
- The P6 WYSIWYG/drag-drop editor; palette/actions editing; custom-block sandbox; block-query params
  editing beyond `top`; voice/register/mode editors (GET /modes is served; PUT /modes/:id stays unwired).
- Client packaging changes; the WS 64KB frame-cap issue (known, separate).

## Slice: Settings sidebar — /setup becomes a real settings surface

**Goal.** Rework the over-simplified one-page admin surface into a sidebar with many nested configuration
sections (in the spirit of glass / openwebui), and raise the visual quality bar so the surface reads as
real SaaS software — disciplined type scale, one control system, hover/active/focus, restrained color. This
slice implements the IA + Features UI from the settings-IA audit with that quality bar as an explicit
acceptance criterion.

### What shipped
- **`GET /settings` (+ `/settings/<section>`)** — a persistent left sidebar + content pane, server-rendered
  per request (no SPA, no framework — the repo's hand-rolled discipline). **`/setup` 301s to `/settings`**,
  preserving `?edit=` / `?surface=` / `?discover=` (README/skills/first-run all still work).
- **Section registry** (`surfaces/settings/registry.ts`), mirroring the client's block-renderer registry:
  each section is a pure `render(SetupData) → string` module registered in ONE table
  `{ id, group, label, render, liveDot? }`. The shell (`shell.ts`) walks it to build the grouped sidebar +
  the active section. **Adding a section is a module + a line** — now a CONTRIBUTING Tier-B recipe
  ("Add a settings section").
- **Sections** (11): top — Status, Get started; MODELS — Endpoints, Profiles, Keys, Local runtimes;
  PIPELINE — Features; SURFACES — HUD layout; DIAGNOSTICS — Benchmarks; bottom — Try it, Privacy. The
  existing pure fns (fabric editor, profiles, secrets, get-started lens, try-it, HUD-layout list) were
  **re-homed** behind the registry by EXPORTING them from `setup/view.ts` — minimal diffs, same behavior,
  their tests re-pointed at the fns directly.
- **Features (NEW, the vision-b centerpiece)** — every seeded flag as a human-named toggle with an honest
  note, grouped by pipeline stage (Capture/Distill/Extraction/Index/Act/Router/Other), with a real toggle
  switch, minTier chip, and **dependency chips** that show live state (distill.transcribe/moments/index +
  act.enabled render "✓/○ needs Distill what is captured", satisfied ↔ unmet as distill.enabled flips).
  Toggling composes the EXISTING `PUT /flags/:key` (the same route the Try-it consent-flip uses) — no new
  engine capability. A presentation registry keyed by flag key supplies the human copy (NOT a contract
  field — the Flag schema is untouched); an unregistered flag still renders (Other, humanized) because
  `GET /flags` drives the list.
- **Status (NEW)** — a live dashboard from data the engine already holds (no new probes): engine uptime,
  active profile + per-slot endpoint occupancy, flags-on count, live session, capture-queue counts.
- **Privacy (NEW, v0 static-honest)** — what mic/Accessibility/Local-Network are for + where to grant
  them, and the honest note that a browser page can't read TCC state (the tray shows live status). Option
  (a) from the audit's open-Q3.
- **Benchmarks (NEW, present-but-future placeholder)** — reserves a DIAGNOSTICS home for the coming
  capability-benchmarking system (hardware envelope → measured tok/s per endpoint → queue policies). The
  endpoint editor's per-row controls now show the **set → connect → test → benchmark** progression: a
  disabled "Benchmark" button with an honest tooltip sits beside the live "Test".
- **Sidebar live dots** (cheap, server-rendered, no polling): llm-configured dot on Endpoints/Get-started,
  live-session dot on Status, features-on count badge on Features.
- **Client (URL strings only, in scope):** `shell.ts` now opens `${engineUrl}/settings` for both the tray
  and the first-run auto-open (which lands on Get started, since `/settings` auto-selects it when the llm
  slot is empty). No other client change (the menu-bar/tray rework is its own slice).

### The seeding gap — reconciled against reality
The audit claimed "four of the six [real gating] flags aren't even seeded documents." **That was reading a
stale, unused `apps/engine/src/flags/defaults.ts`** (it listed only `capture.sim`/`fabric.http`). Reality:
the live seeding source is `shared/contracts/examples/flag.examples.json`, loaded by `ensureDefaultFlags`
(`api/defaults.ts`), and it **already seeds all six** (distill.enabled/transcribe/moments/index,
act.enabled, route.detect) plus capture.camera/surface.block.pinned-doc/voice.drift/ingest.gdoc. `GET
/flags` enumerates all ten. No seeding fix was needed; the misleading dead file was **removed** to prevent
future confusion. Note: `capture.sim`/`fabric.http` are therefore NOT seeded today (they lived only in the
dead file); the Features registry still carries copy for them in case they're hand-set, but they don't
appear until then.

### Craft (the "not a toy" bar)
`settings/assets.ts` extends the setup palette with a real design system following
`design/renderings/hud-v2.html`: a 250px sticky sidebar with grouped micro-label headers, nav items with
hover/active/focus states (accent left-bar + tint + count badge on active), a unified control system
(one input/button/toggle language with focus rings), proper cards with soft shadows, a genuine toggle
switch (track + knob, accent-filled on), a responsive stat grid, and a mobile breakpoint. Verified in a
real browser (headless screenshots): the Features and Status sections read as production software.

### Live verification (engine on :8920, curl + headless browser)
Walked every section: `/settings` default = Status when configured / Get started when the llm slot is empty
(and the first-run banner rides non-get-started sections). `/setup` → 301 → `/settings` (Location header
asserted). Flipped `distill.enabled` via the toggle's exact route → `GET /flags` reflected it, the Features
section showed it checked + dependents' chips flipped to satisfied, and the sidebar features-on count went
0 → 1 on reload. Drove re-homed flows: activated a profile (Profiles marks it active), opened the HUD-layout
editor at `/settings/hud-layout?surface=<id>` and round-tripped a surface save (v1 → v2). Endpoints editor
shows Test + the disabled Benchmark affordance.

### Rule-7 check (definition of done)
Kept true IN these commits: README (`/settings`, first-run, the Models group, the HUD-layout URL);
`skills/add-a-block` (the editor URL is now `/settings/hud-layout?surface=`); CODE_MAP (the `settings/`
module, the feature-home table rows for the sidebar / Features / discovery / Try-it, the status line);
CONTRIBUTING (new Tier-B recipe "Add a settings section"); this note. New flag: none (serving a settings
section is a read surface; writes compose existing routes). Contract change: none (human copy lives in the
view's presentation registry, not the Flag schema).

### Tests + status
Green: contracts 45, engine 228, client 139 (one known client-seam TOCTOU flake, passes on rerun). New
coverage: registry/shell (grouped sidebar, default-section selection, active state, unknown-id fallback,
live dots, banner behavior, every-section-non-empty, Status/Privacy/Benchmarks content) in
`settings/shell.test.ts`; the Features section (human names + keys + minTier chips, stage grouping,
dependency notes with live satisfied/unmet state, on-count + checked state, unregistered-flag fallback) in
`settings/sections/features.test.ts`; the Features API round-trip + all-six-seeded assertion, the /setup
301, and the sidebar-shell serving in `api/http.test.ts`; the re-homed setup section fns tested directly in
`setup/view.test.ts` (updated from the old whole-page assertions).

### Deferred (out of this slice, by scope)
- The menu-bar/tray rework (viability gate, "Finish setup…" lead, HUD unreachable/empty fallback) — the
  audit's Slice 3, its own slice.
- Capture-source runtime toggles (mic/system/focus env→document migration) — the audit's open-Q1, separate.
- Status → per-source last-capture-ingress ("mic: last heard 3s ago") — needs engine plumbing (QueueStatus
  carries only aggregate counts); shipped Status v1 without it, noted in-section.
- The capability-benchmarking system itself (measured tok/s → queue policies) — reserved under DIAGNOSTICS
  as an honest placeholder; its own later slice with a design note.
- Workspaces/hints section, Voice & registers browser, live TCC detection in Privacy — separate slices.

---

## INVOKE-RESILIENCE + HONEST-ERRORS (2026-07-08)

The motivating wall, hit twice on a real rig: LM Studio's 35B fails to LOAD (HTTP 400 on completions)
while a base-URL ping returns 200. Three lies followed — the drain re-queued silently forever; the Try-it
diagnose path (which trusted the ping) said "the model may be slow… try a clearer commitment"; and a
perfectly good loaded model (qwen3.5-9b) sat unused because nothing surfaced what the server actually had.
The requirement: detect the difference between a failed API key and a model that's not loading, and
suggest a troubleshoot step. This slice makes every invoke failure
CLASSIFIED and surfaced — the drain never re-queues silently again.

### The taxonomy (`engine/fabric/invoke-error.ts`)
`InvokeError` carries a `class` + endpoint (named, never a secret) + a one-line troubleshoot `hint`; the
final throw of invokeLlm/invokeStt is an `AggregateInvokeError` whose `failures[]` keeps every endpoint's
class (fall-through semantics unchanged — a classified failure is still just a reason to try the next
endpoint). Classes and how each is detected:
- `unreachable` — fetch threw ECONNREFUSED/DNS (`classifyFetchError`).
- `timeout` — the AbortController fired (our own timeout).
- `auth` — HTTP 401/403, OR an `auth.keyRef` with no stored value (thrown BEFORE any fetch). Names the
  keyRef, never the value; hint → "check key <ref> in Settings → Keys".
- `model-load` — a non-ok body reading like a load failure (`/failed to load|not loaded|…/`), OR any 400 /
  5xx. Captures the server's own message VERBATIM. **LM Studio's exact 400** `{"error":"Model \"…\" failed
  to load. Error: …"}` lands here. Hint → "model <id> failed to load on <url> — pick a smaller/loaded model
  in Settings → Endpoints".
- `reasoning-exhausted` — (added mid-slice, from a rig diagnosis) HTTP 200 with empty content while the
  model spent its budget thinking: a non-empty `reasoning_content` and/or `finish_reason:"length"` (LM Studio
  serving qwen3.5-9b reproduces this deterministically at a low max_tokens). A DISTINCT, user-actionable
  state — NOT `bad-response`. Hint → "model <id> spent its entire token budget thinking and returned no
  output — use a non-reasoning instruct model for this slot, or raise the mode's token budget". (Passthrough
  of enable_thinking/response_format is the separate omlx-integration slice — deliberately not done here.)
- `bad-response` — non-JSON, missing shape, or an unexpected HTTP status (404/429): the wrong URL/shape.

### `GET /queue` (the contract's phase-3 route, now implemented)
`QueueStatus` gained `lastFailure` (the new `QueueFailure` contract: class + endpoint + model? + keyRef? +
serverMessage? + hint + at) and `lastSuccessAt` — both additive/optional (`pnpm --filter @openinfo/contracts
gen`). Drain state lives IN-MEMORY on the CaptureQueue (justified: it's operational status about THIS
process — no user intent, recomputed each run, no version history worth keeping — exactly like drainedFiles,
not a store document). The drain records the classified failure via an injected `describeFailure` seam
(`fabric/diagnose.ts` `toQueueFailure`), so the queue keeps zero fabric/invoke dependency.

### Real-generation probe (`POST /fabric/test`, `probe:'generate'`)
The ping lied, so the Endpoints Test button now runs ping THEN a real 1-token completion through the ACTUAL
invoke path for llm rows, reporting both ("reachable · generation ✓ 412ms" / "reachable · generation ✗
model-load: …"). `probe` + `slot` are additive TEST-request fields, stripped before Endpoint validation
(the Endpoint schema is additionalProperties:false and these aren't part of the stored doc). stt rows are
skipped-with-note (a generation probe needs audio — out of scope). `EndpointProbe` gained an optional
`generate` sub-result (`GenerateProbe`). Value-free re keys throughout.

### The Try-it card stops guessing — three truths, three messages
`diagnose` now reads `GET /queue` instead of pinging and inferring. The pure decision is
`tryItDiagnosis` (`setup/view.ts`, asserted headless; the browser mirrors its branch order):
1. a classified failure ON the current llm endpoint → THE REAL ERROR + hint + a link to Settings →
   Endpoints ("The model couldn't answer — model-load: Model … failed to load.");
2. the chunk still pending with no matching failure → "Still queued — the model is slow, but your text is
   safe and will process. Give it a moment." (a distinct, reassuring state);
3. a healthy queue, no failure → "No moments found in your input — try a clear commitment or decision …".

### Loaded-model awareness (suggestion, NOT automation)
When a `model-load` failure is surfaced, the hint is enriched with what the server DOES have: a read-only
`/v1/models` probe (`discover.ts` `listLoadedModels`/`loadedModelSuggestion`, reused read-only) appends
"server reports N other models (e.g. <first two>) — switch in Settings → Endpoints". Enrichment happens in
`fabric/diagnose.ts`, so the drain's recorded hint, the generate-probe hint, and (via the queue) the Status
and Try-it surfaces all carry it. We do NOT auto-switch — user agency; a future `auto` endpoint option is
deferred.

### Status section
The Capture-queue card gained the classified last-failure readout (class + endpoint + model + the hint) and
a last-drain-ok line — the operational dashboard now shows WHY nothing is arriving, never silent.

### Rule-7 check (definition of done)
skills/ and README mention neither `/fabric/test` nor `/queue` — nothing to keep true there. Contracts:
`QueueStatus` (+`QueueFailure`, +`GenerateProbe`, +`EndpointProbe.generate`) — additive, examples added,
schemas regenerated. New flag: none (classification/probing is engine-internal; the generate probe rides
the existing test route). CODE_MAP: added the `GET /queue` + resilience row.

### Tests + status
Green on rerun: contracts 48, engine 258 (drain-timing e2e + client-seam TOCTOU are the pre-listed flakes —
pass in isolation). New coverage: per-class classification incl. LM Studio's verbatim 400 body and the
reasoning-exhausted 200 shape, plus fall-through preserving classes (`invoke-error.test.ts`); toQueueFailure
enrichment (`diagnose.test.ts`); GET /queue empty/success/classified-failure states (`spool.test.ts`);
generate-probe success + model-load(+suggestion) + auth + stt-skip and GET /queue over HTTP
(`api/http.test.ts`); the Try-it three-truths decision (`setup/view.test.ts`).

### Deferred (out of this slice, by scope)
- Auto-model-switching / a `local.auto` endpoint option — noted as a future option; user agency for now.
- enable_thinking / response_format passthrough + reasoning_content fallback-parsing — the omlx-integration
  slice (we DETECT reasoning-exhausted here; we don't yet reshape the request to prevent it).
- retry-at-idle llm.smart upgrades; the capability-benchmarking system (placeholder stays); stt generation
  probes (need audio); the WS frame-cap fix.

## HOST-SCAN + MODEL-DROPDOWN (2026-07-08)

Design goal: host detection should lead to a per-model dropdown rather than requiring a full model id to
be typed by hand. Pick a host, scan the common ports, detect a missing API key, list the returned models,
and store them on the call (no cache needed — it is hit infrequently), yielding a capabilities list.

Root cause: `fabric/discover.ts` already did all of this — probe ports, fetch `/v1/models`, classify via
the capability-map document — but ONLY against the localhost probe list, and the Endpoints editor's model
field was free text that never saw discovery data. This slice wires them together.

### `POST /fabric/scan` (`ScanRequest` → `ScanResult`, additive)
Exactly one of `url` | `host` (+ optional `keyRef`). An exact `url` probes that base URL; a bare `host`
expands to the probe-list DOCUMENT's ports (`fabric/scan.ts` `hostTargets` — the "common ports" are the
same stored conventions discovery reads, never a hardcoded list; a user who added a nonstandard port gets
it in the scan too). Per base URL: `reachable`, `authRequired` (a 401/403 answer IS a responding server —
reachable stays true, the editor wires a keyRef and rescans), `models: [{id, slots[]}]` classified through
the capability map, and a classified `error` when dead — the SAME classes the drain/generate-probe use
(unreachable · timeout · auth · bad-response, standard hints). Parallel, ~1.5s timeouts, NEVER cached
(the user's explicit call — fresh per click). POSTURE: the engine is localhost-only (auth P7); this is
a user-directed probe of a host the user typed, not an unsolicited subnet sweep (the consent-gated LAN
sweep stays future). VALUE-FREE: the keyRef resolves server-side into a bearer; an unresolved keyRef fails
honestly BEFORE any fetch, naming the ref only — asserted no-key-material on every result.

### The Endpoints editor
Every http row gains **Scan** beside the URL field. On result the free-text model field becomes a REAL
styled `<select>` of the discovered models: slot-matching models lead ("llm — matches this slot"), the
rest sit under an "other models" divider, every option carries capability chips ("ornith-1.0-9b — llm",
"qwen-vl — llm/vlm"), and the final "custom…" option swaps back to free text — never a trap. An existing
model value the server did not report is KEPT as its own selected option, never silently dropped. The row
detail renders the user's capabilities list — live against the real LM Studio: **"found 36 models —
30 chat · 4 ocr · 2 embed — pick one in the model dropdown"** (derived from the classification, counts per
slot largest-first, llm reads as chat). `authRequired` → "this server wants a key — … — then Scan again"
+ the keyRef selector highlighted; rescan picks up the key and clears it. Dead host → the classified
error + hint (the generation probe's copy discipline) + a "scan common ports on <host>" offer; a bare host
typed straight into the URL field sweeps the ports directly and fills the URL from whichever port
answered, alternatives one click away ("or use http://localhost:11434 (0 models)").

All decisions are PURE view fns in `setup/view.ts` (`capabilitySummary` · `groupModelsForSlot` ·
`modelOptionLabel` · `modelDropdownHtml` · `scanStatusLine` · `bareHostOf`), asserted headless; the
browser script mirrors them (the `tryItDiagnosis` discipline) and composes only `POST /fabric/scan`.
Get-started/discovery is UNCHANGED — this is the advanced-path twin of the same mechanism.

### A real-world find
Ollama with zero models pulled answers `GET /v1/models` with `{"object":"list","data":null}` — `data`
null, not `[]`. The scan treats that as a LIVE server with nothing loaded (reachable, 0 models), not
`bad-response`, so a bare-host sweep of `localhost` honestly finds both :1234 (36 models) and :11434.
(discover.ts still reports it not-reachable for onboarding purposes — deliberate: an empty server
contributes nothing to a config-1 suggestion; revisit if it confuses.)

### Rule-7 check (definition of done)
README documents the Get-started flow only (unchanged); skills/ ships no endpoint-setup recipe yet
(`wire-a-fabric-endpoint` is still in the planned list) — nothing to keep true. Contracts: additive
(`ScanRequest`/`ScanResult` + the `POST /fabric/scan` route row), examples added, schemas regenerated.
New flag: none (a user-directed scan behind a button needs no gate). CODE_MAP: scan tree line + slice row.

### Tests + live verification
Contracts 51, engine 281 — green (known flakes reran clean). New coverage: `fabric/scan.test.ts`
(hostTargets order/dedupe/malformed, classification, bare-host multi-port, 401+keyRef unlock, unresolved
keyRef, dead/bad-response/timeout classes, Ollama null-data, value-free asserts), `api/http.test.ts`
(exact-url, probe-list-document sweep, auth flow value-free, scan→select→save→GET round-trip),
`setup/view.test.ts` (summary format, grouping, chips, custom escape, kept-unknown-current, hostile-id
escaping, status lines, bare-host parse, Scan button placement). Live on :8922 against the real LM Studio
(:1234, 36 models): the scan returned ornith-1.0-9b/-35b/-mtplx classified llm, glm-ocr variants ocr,
nomic/lfm2.5 embed; a real Chromium drive showed the dropdown grouped (30 llm / 6 other), ornith under
"llm — matches this slot", custom… restoring the input with the value kept, the dead-port state offering
the common-ports sweep that filled the URL with :1234, and the fake-401 flow (highlight → key → rescan →
"found 2 models — 1 chat · 1 stt").

### Deferred (out of this slice, by scope)
Caching/background rescan (explicitly declined by the user) · mDNS/subnet discovery (consent-gated LAN
sweep, unchanged) · benchmarking (placeholder stays) · auto-selecting a model on failure (suggestion
machinery only — user agency) · surfacing the scan inside Get-started (localhost onboarding unchanged).
