# openinfo — architecture

**Status:** design, pre-code · 2026-07-07
**Prior art absorbed:** pickle-com/glass (strangler fork target), Zackriya-Solutions/meetily, tinyhumansai/openhuman, shlokkhemani/rabbithole, n8n/activepieces/fabric, loom (`~/Apps/Monorepo/loom` — salvage: `bus`, `recipe`, `store`)
**Renderings:** [surfaces v0.2](https://claude.ai/code/artifact/1ab5cf66-4f20-4179-ab49-7181e9cc8cba) · [HUD](https://claude.ai/code/artifact/3c9d3142-866d-4807-90fb-6b0ef79d1468)

---

## 1. What this is

A persistent companion that watches and listens (screen, mic, calendar, repos), distills everything it captures
through a user-configurable workflow engine, and maintains a live join between *what is happening now* and
*everything this context has seen before* — surfacing artifacts, drafting follow-ups, and keeping an
evidence-checked ledger of what you owe and are owed.

**The prime directive: the app prepares, the human executes.** It drafts the email, finds the excerpt, readies
the checkbox — it never sends, commits, or replies on its own.

**Product principles** (from the HUD design, they govern everything):

1. Nothing surfaces without a one-line *why* (provenance or it doesn't ship).
2. Say it once — no chrome that restates itself; one dot is the heartbeat.
3. Events, not buckets — moments carry their own timestamps and marks.
4. Density follows reality — no layout minimums to fill.
5. Plumbing (queues, tok/s, backends, modes) never appears on the glass you look through all day.
6. Blocks, not layouts — defaults are a starter kit, not a verdict.

---

## 2. The shape

```
┌─────────────────────────────┐         ┌──────────────────────────────────────┐
│  CLIENT (thin)              │  HTTP   │  ENGINE (daemon)                     │
│  Electron shell from glass  │  + WS   │  localhost by default,               │
│                             │◄───────►│  any host:port by config             │
│  capture/   mic, screen Δ,  │         │                                      │
│             calendar, focus │         │  api/        typed routes + events   │
│  surfaces/  HUD, workbench, │         │  workflow/   DAG executor (loom      │
│             settings        │         │              recipe) — runs modes    │
│  engine-link/ offline spool │         │  distill/    rolling merge, OCR      │
└─────────────────────────────┘         │  route/      context switch, identity│
                                        │  index/      entities, canon, ingest │
        shared/contracts/               │  ledger/     commitments, watchers   │
        nothing crosses the             │  store/      loom store + sqlite-vec │
        seam untyped                    │              ONE DB FILE / WORKSPACE │
                                        │  queue/      backlog, drain, ETA, GC │
                                        │  overlay/    tone, rules, roles      │
                                        │  fabric/     capability slots →      │
                                        │              endpoints (see §8)      │
                                        └──────────────────────────────────────┘
```

Two rules make everything else possible:

- **The client never touches a database.** Every pixel it renders came through the API. This is what makes the
  remote backend a config option, what makes custom blocks safe, and what makes the old column-filter isolation
  failure structurally impossible.
- **Everything the user can configure is a document.** Surface layouts, modes, overlays, endpoint maps, pins —
  all JSON/YAML records in the store: versioned, diffable, exportable, cloneable. "Templates" and "WYSIWYG"
  fall out of this for free (§6, §7). If a feature can't be expressed as a document the user could hand to a
  friend, its design is wrong. Feature flags are documents too (`{ key, default, scope, description }`) —
  standardized from day one, settable per user and per context.

---

## 3. Primitives

### Processing primitives (what modes are made of)

| Primitive | Job |
|---|---|
| **Source** | Capture, cadence-gated: mic, screen Δ-diff, calendar, repo/window focus, camera (flagged; presence first) |
| **Distill** | Rolling merge (e.g. 30s → 2m), OCR distill, token-budgeted per pass |
| **Route** | Context-switch detection, workspace attribution, identity resolution |
| **Overlay** | Voice as **dials** (tone, warmth, wit, charm, specificity, brevity — 0–10) grouped into named **registers**, bound per context and interpolated into prompt templates as pre-processing variables; plus rules/lenses, roles, ontology. Includes the live **register comparator** with per-mode drift escalation chains. Applied to outputs, never raw capture. See IMPLEMENTATION.md §1 |
| **Act** | Prepare artifacts: drafts, ledger items, nudges, exports. Never executes outward |

### Capability slots (what processing runs on) — see §8

`stt` · `tts` · `llm` · `vlm` · `ocr` · `embed` — each a named slot filled by one or more endpoints.

### Display primitives (what surfaces are made of) — see §6

| Primitive | Job |
|---|---|
| **Surface** | A window/panel the client renders: the HUD, the workbench, a settings pane |
| **Block** | `query + renderer + placement + actions` — one unit in a surface's stack |
| **Action** | A declarative verb a user can press: copy, open, mark-done, run-mode, draft-with |

### Records (what the store holds)

| Record | Contents |
|---|---|
| **Workspace** | One SQLite file. Sessions, moments, entities, ledger, pins, layout docs scoped to it |
| **Session** | A routed span of time: attribution evidence, distillates, moments |
| **Moment** | Timestamped typed event: commitment ● / question-at-you ◆ / decision ▲ / artifact ✱ / note |
| **Entity** | Person, artifact, topic. Canonicalized; carries every reference back to moments |
| **Commitment** | The richest record: text, provenance moment, who's owed, **watchers**, evidence, status, attached context (open file, OCR, PR) |
| **Pin** | Canon declared by the user. Ingested (fetched, chunked, page-anchored, embedded), not bookmarked |

---

## 4. Data & isolation

- **One SQLite file per workspace** (`sales.db`, `ingest-api.db`, `platform.db`). Delete/export/encrypt a
  workspace by handling one file. The old attempts failed because "workspace" lived at the window layer and
  isolation was a `WHERE uid = ?` filter on one shared DB — never again.
- **A small rolling capture buffer** (raw, minutes-scale, one file) feeds the router. Once a session is
  attributed, distilled artifacts land in that workspace's DB and the raw expires (or spools to the deferred
  queue if the active mode is over hardware budget — §7).
- **Cross-workspace entity graph** lives beside the workspace files: it holds edges only (entity ↔ entity,
  entity ↔ workspace), so recall can cross workspaces while the content itself stays isolated. Vector search via
  loom's store with the `sqlite-vec` adapter; `embed` slot supplies vectors.

---

## 5. The context index & the ledger (the intelligence)

**Index** — extraction free-rides on the distill pass (no second model call): every pass emits typed entities
with pointers to their moments. Canon is *earned* (repeat references merge; the version you actually **sent to
someone** outranks versions you merely viewed) or *pinned* (pre-seeded canon; pins are ingested with page
anchors, which is how an answer cites "p. 42" with a copy-ready excerpt). Live ranking:

```
score = match(live stream) × recency × frequency × person-affinity(people in the room)
```

**Ledger** — commitments are born with **watchers**: a code promise watches the repo, a doc promise watches the
doc, a mail promise watches outbound mail. "Did I?" is answered by evidence and *asked* only when every watcher
comes back empty. Items auto-close with their evidence attached (commit hash, sent thread). New items are born
from observation with context attached — "need your help with the dedupe race" arrives carrying the open file,
the OCR'd traceback, and the PR it touches. The ledger keys to **people + topic, not calendar events**, so a
debt surfaces wherever its creditor appears.

**Overflow rule** — the ledger banks *everything* (10 things happen → 10 items stored). A HUD block surfaces
its configured top-K (default 2–3) by the ranking above, plus a link into the **workbench** (§6) which holds
the full list. Each item is an action card: checkbox lifecycle `open → prepared → done`, and "prepared" means
the artifact is ready — the draft email, the excerpt, the quote-request text — with a copy button. The human
pastes it into Gmail, finds the rep's address if we don't have it, and sends. The checkbox records it.

---

## 6. Configurable frontend — surfaces, blocks, templates, WYSIWYG

A **surface** is a document:

```jsonc
{ "surface": "hud", "context": "meeting",          // layouts key to context type
  "stack": [
    { "block": "now" },                              // built-in, always on top
    { "block": "relevant-now", "query": "join(live, index).top(4)" },
    { "block": "pinned-doc", "doc": "soc2-typeII-2026",
      "show": "always", "copybar": true, "answers": { "cite_pages": true } },
    { "block": "ledger", "query": "owed(people_in_context)", "top": 2,
      "more": "workbench://ledger" },
    { "block": "moments", "collapsed": true }
  ] }
```

- **Templates are just surface documents shipped in a gallery**: a *meetily-like* surface (meeting list +
  transcript + summary panes), a *glass-like* surface (two-button pill, nothing else), the *openinfo HUD*
  (the live-join panel). Cloning a template = copying a document. Sharing your setup = sending a file.
- **The WYSIWYG editor edits the document**: drag to reorder, chevron to collapse, × to remove, "+ add block"
  from the library, inspector for the selected block (query, visibility, density, per-block model). This editor
  is itself a surface.
- **Three tiers of creativity:** (1) everyone arranges built-ins; (2) power users write queries — the same
  `recall()`/`join()` calls the built-ins use; (3) builders ship **custom blocks**: self-contained HTML served
  by the engine (the rabbithole pattern — shell/styles/client-chunks), rendered in a sandboxed webview with a
  postMessage bridge to the API. A custom block *cannot* reach a DB or the filesystem; it can only ask the
  engine. Custom buttons are the same idea one size down: an **action** document (label + verb + endpoint).
- **The workbench** is the roomy companion the HUD links into: a web app (Vite) served by the engine itself —
  full ledger, session archive, explore canvas, analytics. Same API, bigger screen. Because the engine already
  speaks HTTP, the workbench runs in any browser pointed at it — including on a machine that isn't running the
  client at all.

**Feasibility:** this is the cheap kind of flexibility — the client never owned data, so every built-in block
is already an API call. "Opening" the frontend = publishing the block schema + the layout document format +
the sandbox bridge. The WYSIWYG is a form over JSON.

---

## 7. Configurable backend — modes, the canvas, templates

A **mode** is a document too: a named bundle of processing config that compiles to a DAG the workflow engine
(loom's `recipe` executor) runs.

- **Form view** for most users: sources + cadences, model picks with *measured* tok/s, merge windows.
- **Canvas view** (n8n-style) for power users: the same mode as nodes and edges, vocabulary fixed to the five
  processing primitives. Editing either view edits the same document.
- **Mode templates** ship alongside surface templates: `meeting`, `deep-work`, `interview`, `conference-day`.
  A "meetily clone" is one of each: the meetily surface + a meeting-scribe mode.
- **The hardware envelope is honest:** a mode may exceed the machine. The envelope check compares required vs
  measured throughput and the user picks the overflow policy — **queue raw for later** (process at idle, delete
  raw after), degrade cadence, or drop. Backlog analytics project when the queue clears at current drain rate.

---

## 8. The endpoint fabric — multi-configurable capability slots

Every model-shaped need is a **capability slot**; every slot is filled by an ordered list of **endpoints**.
Modes and blocks reference slots by name — never a vendor, never a model id.

```yaml
fabric:
  stt:
    - { name: parakeet-local,  kind: local,  model: parakeet-110m }
    - { name: stt-box,         kind: http,   url: "http://192.168.1.101:9000", api: openai-compat }
  tts:
    - { name: kokoro-local,    kind: local,  model: kokoro-82m }
    - { name: tts-box,         kind: http,   url: "http://192.168.1.102:9100" }
  llm:
    - { name: llm.fast,        kind: http,   url: "http://192.168.1.104:8787", model: llama-3.2-3b }   # 88 tok/s
    - { name: llm.smart,       kind: http,   url: "http://192.168.1.104:8787", model: qwen3-8b }        # 41 tok/s
    - { name: gemini-live,     kind: cloud,  provider: google, auth: keychain }                        # optional
  vlm:
    - { name: vlm-local,       kind: local,  model: qwen2.5-vl }
  ocr:
    - { name: ocr-box,         kind: http,   url: "http://192.168.1.103:8600" }   # a second computer just for OCR is a supported topology
    - { name: ocr-local,       kind: local,  model: apple-vision }
  embed:
    - { name: embed-local,     kind: local,  model: nomic-embed }
```

- **Three endpoint kinds:** `local` (a process the engine manages), `http` (any reachable host:port — three
  different computers for tts/stt/llm is the intended topology, not an edge case), `cloud` (authed service —
  Gemini Live, Anthropic, whatever; credentials in the OS keychain, never in documents).
- **Order is fallback.** First healthy endpoint wins; health checks and *measured* benchmarks (tok/s, latency)
  are stored per endpoint and feed the mode envelope math.
- **Offline is a guarantee, not a mode:** every slot must resolve to at least one local candidate, or the
  features needing it degrade to the queue. Cloud endpoints are enhancement, never dependency. Pull the network
  cable and openinfo keeps capturing, keeps distilling at local speed, keeps its ledger.
- Per-node override in modes: a distill node says `use: llm.smart`, a hint block says `use: llm.fast`. Named
  tiers, so swapping hardware means editing the fabric doc, not every mode.

### Fabric profiles, secrets & the setup surface (design note — 2026-07-07)

The fabric above describes *one* slot→endpoints map. But a user's rig is not fixed: config 1 is an 8B in
LM Studio; config 2 moves the smart tier to a 27B on another host over http; config 3 adds a 4B OCR box and
parakeet STT here, TTS there, some of it over tailscale at acceptable-degraded speed. **Every such
combination is a document** (§2's rule, applied to the fabric) — named, versioned, cloneable, switchable.

- **FabricProfile.** A named, versioned document `{ id, name, version, fabric, description? }` whose `fabric`
  is exactly the existing §8 `Fabric` shape (full slot→endpoints map). Profiles are stored like every other
  config document (LayoutStore in `_meta.db`, one row per version — cloning is copying a document, history is
  kept, a wrong document can't ship). Seeded examples ship: `lm-studio-local`, `ollama-local`,
  `remote-http-template`.
- **The live fabric IS a profile.** One "active profile" pointer names which profile is live; *activating* a
  profile makes its map the fabric that health/bench/invoke run against. **`GET`/`PUT /fabric` stays** as the
  active-profile view for backward compatibility: `GET /fabric` returns the active profile's map; `PUT /fabric`
  edits the active profile in place (bumping its version). The pre-profiles single fabric doc is the fallback
  when no profile is active (fresh installs and the ungated quickstart keep an empty `llm` slot — seeded
  profiles are inert until explicitly activated, so nothing changes what `GET /fabric` returns until a user
  opts in). Switching rigs = `POST …/activate`; the live fabric swaps atomically and a `fabric.changed` event
  announces the new map to any listener (HUD, setup page).
- **Secrets never live in documents.** An endpoint that needs a credential carries `auth: { keyRef }` — a
  *name*, never a value. The value lives in an **engine-side secret store**, addressed by ref. v0 is a
  chmod-600 JSON file kept in its own `secrets/` directory beside the workspace DBs (never inside any `.db`,
  so it is never part of a one-file workspace export; env-overridable). The store is an **interface**
  (`set`/`delete`/`resolve`/`listRefs`) so the macOS **Keychain** implementation slots in at P7 (§3) with no
  caller change. The API is **write-only**: you `PUT` a value, you `DELETE` it, you `GET` the list of *refs* —
  no route, event, GET response, document, or export ever carries key material. This is deliberately the same
  never-echo-to-UI discipline the app already uses; the secret is injected **only at invoke time** as
  `Authorization: Bearer <resolved>` for the http endpoint that declared the ref. A missing/unresolvable ref
  makes that endpoint **fail health/invoke gracefully** — it falls through to the next endpoint in fabric
  order, never crashes, and never logs the key (only the ref name appears in a failure list). Header choice:
  `Authorization: Bearer` (the OpenAI-compatible convention these endpoints already speak); a bespoke header
  would be an additive `auth.header`/`auth.scheme` field later, not a v0 concern.
- **The setup surface** (next slice, *not* built here) is forms-over-documents served by the engine, exactly
  like the coming WYSIWYG editors (§6): a page to name/clone/activate profiles, wire slot→endpoint rows across
  hosts, and enter/forget keys through the write-only secret API. It composes only over the routes below — it
  needs no new engine capability, consistent with the P6 "forms over documents, no new engine capability
  allowed" rule.
- **No flag.** Profiles and secrets are resource routes (like `/sessions`, `/layouts/surfaces`), not gated
  processing behaviors — the established no-flag line. What a profile *switches on* (distill/act) is already
  gated; a `fabric.profiles` flag would gate nothing not already gated.

### Onboarding from first principles — discover, the capability lens, tier zero (design note — 2026-07-07)

The fabric setup surface above is *forms over documents* — powerful, but it asks a new user to know ports,
model-capability trivia, and OpenAI-compatibility conventions. The founder configuring his OWN product hit
exactly that: template fixes, port lookups, which model is an OCR model, two TCC permissions. Onboarding must
be **simple for a new user in a standard flow**, designed from first principles. The substrate does not
change — profiles/keyRefs/slots stay exactly as the note above defines them. This is a **lens** over the same
documents, plus one new read-only engine capability (discovery). Six principles govern it:

1. **Detection over configuration.** LM Studio :1234, Ollama :11434, kokoro :8880 (and common whisper-server
   ports) are *conventions*; `GET /v1/models` enumerates what is actually loaded; model *names* classify
   capabilities (contains `ocr` → ocr; `embed` → embed; `-vl`/`vision` → vlm; `whisper`/`parakeet` → stt;
   `kokoro`/`tts` → tts; else → llm). So the first screen is a **result** — "Found LM Studio with 37 models.
   Use it?" — not a form. Two seeded, versioned **documents** carry the conventions (everything configurable
   is a document): a **probe list** (well-known local servers) and a **capability map** (name-pattern → slot
   rules). `GET /fabric/discover` probes the list in parallel (~1 s each, never throws), classifies every
   model, and synthesizes a **suggestion**: a one-endpoint-per-slot config-1 fabric.
2. **Capabilities, not plumbing.** The onboarding lens speaks in what the app can *do*: **Hearing** (stt) ·
   **Thinking** (llm) · **Reading the screen** (ocr/vlm) · **Speaking** (tts) — each row showing what was
   found, what is missing, and one honest line ("no transcription server found — openinfo still distills
   typed/text capture; audio needs one"). Slots/profiles are still the substrate; the lens is a projection.
3. **Tier zero (design-noted, NOT built here).** No server at all is the true first run. The designed home is
   the **existing stubbed `local` endpoint kind** (§8): the engine downloads and spawns a managed runtime
   (`mlx`/`ollama`/`whisper.cpp`/…) and fills a slot with a `local` endpoint. `fabric/invoke.ts` and
   `health.ts` already *skip* `local` gracefully (they fall through), so tier zero is additive: implement the
   runtime lifecycle behind the same `Endpoint` contract, no caller change. **Slice (c).**
4. **One decision at a time.** "Use what we found?" writes and activates a `config-1` profile **silently**,
   through the EXISTING profile routes (`PUT /fabric/profiles/config-1` + `POST …/activate`) — no new write
   semantics. Power features (naming/cloning/cross-host rows, keyRefs, inert slots) live behind an **Advanced
   setup** disclosure that is the existing editor, unchanged.
5. **Verify by doing (design-noted, NOT built here).** After "Use this setup", a "say something → watch it
   become a moment" live loop closes the trust gap. It is **client-side** (it needs the mic and getUserMedia,
   and the mic-permission prompt belongs in-flow, right when the user chooses to speak), so it lands in the
   client, not this engine slice. The engine already exposes everything it needs (capture → distill → moments
   → `GET /moments` / the moment WS event). **Slice (b).**
6. **Gotchas as affordances.** Onboarding must metabolize the real traps: mic TCC asked *in context* (slice b);
   "server installed but not running" deep links (`lmstudio://`, future); and the macOS **Local Network TCC**
   finding below.

**Scope of THIS slice:** discovery (the two documents + `fabric/discover.ts` + `GET /fabric/discover`) and the
**Get Started lens** on `/setup` (the capability checklist + the one-button "Use this setup" → config-1).
Deferred, each with its home named: (b) the say-something verification loop (client); (c) engine-managed
`local` runtimes / tier zero (`fabric` `local` kind); future — with-permission **LAN sweep** discovery (the
founder's own rig is cross-host: STT on one box, LLM on another, some over tailscale — a subnet sweep with
explicit consent extends `fabric/discover.ts`) and `lmstudio://` launch deep links.

**The suggestion heuristic (documented so it is inspectable, product principle 1).** Reachable servers only, in
probe-list order, then model order within each: for each slot pick the first model classified into it. For the
**llm** slot, prefer a *pure* chat model (classified `llm` and nothing else) over a multi-slot model (a
vision-language model is both `vlm` and `llm`, but should not become the default chat model when a plain chat
model exists). For **non-llm** slots, only explicitly-classified models qualify (the default rule only ever
produces `llm`, so non-llm membership is explicit by construction — this is what "prefer explicit-capability
over default" means). No quality ranking yet (param count, measured tok/s) — "best available" is deterministic
first-match; a real rank is future, and the user always sees every found model and can pick via Advanced.

**Platform note — macOS Local Network TCC (cost the founder a day).** On macOS, contacting a host on the local
network (a bare LAN IP or `*.local`, and in some OS versions even loopback probes from certain contexts) can
trip the **Local Network** privacy gate. A process running in a **GUI login session** can raise the system
prompt and, once approved, reach LAN hosts; a process **orphaned from ssh** (a daemon started over a headless
ssh session, detached from any Aqua/GUI session) is **silently denied** — no prompt, no error, connections
just fail. This matters for cross-host rigs and for engines on **headless test boxes**: such an engine must run
from a **GUI-domain LaunchAgent** (`launchctl … gui/<uid>`), not a raw ssh-spawned process, or its LAN probes
(the future sweep) and cross-host http endpoints will fail invisibly. Localhost discovery in THIS slice is not
affected in practice, but the sweep (future) and multi-host profiles are — recorded here so the sweep slice
starts from the answer, not the lost day.

---

## 9. What transplants, from where

| From | Take | Leave |
|---|---|---|
| **glass** (`~/Glassolution1` / upstream) | Electron shell, content-protection + hide-from-screenshare windowing, mic/system-audio capture, AEC WASM, STT factory pattern, screenshot distiller | Firebase (`functions/`, `sync_state` cols), shared single DB, hardcoded prompt presets, `pickleglass_web` |
| **loom** (`~/Apps/Monorepo/loom`) | `packages/bus` (events), `packages/recipe` (DAG executor → workflow/), `packages/store` + sqlite-vec (→ store/, recall) | `engine`/`graph`/`cli` (empty stubs), everything else until proven needed |
| **NanoGlassBackup** | The crate-boundary *idea* (contracts/runtime/storage/providers/capture) as the contracts layering reference | The Rust code itself, for now |
| **rabbithole** | The engine-serves-self-contained-HTML pattern for custom blocks and the explore canvas; the lens pattern for overlay rules | — |
| **meetily / openhuman** | Reference only: bundled local inference; checkpointed-graph "subconscious" loop | — |

---

## 10. Hard parts, ranked honestly

1. **Context-switch detection quality** — the router is the product's spine; wrong attribution poisons the
   workspace DBs. Needs evidence-based attribution (window title + repo path + calendar + voices) with a cheap
   one-click reroute that retroactively moves a session.
2. **Extraction quality on small local models** — entities/commitments from a 3–8B model will be noisy.
   Mitigations: tight schemas, the confirm/dismiss teaching loop (every dismissal is a training signal), and
   the queue (re-extract at idle with `llm.smart`).
3. **Voice → person resolution** — diarization is optional at first; calendar attendees + explicit
   confirmation ("was that Dana?") get 80% of the value.
4. **OCR throughput** — screen Δ-gating is what makes it tractable; a dedicated OCR endpoint is the pressure
   valve (§8).
5. **The WYSIWYG editors** — *not* actually hard (§6, §7): forms over documents. Listed here because prior
   attempts died refactoring toward flexibility that documents give for free.

---

## 11. Build order (first vertical slice)

1. `shared/contracts` — API routes, event schema, and the record types (§3), **commitment** and
   **surface/block** first. This document's schemas become code here.
2. `apps/engine` skeleton — api + store (loom transplant, DB-per-workspace) + fabric with `local` and `http`
   endpoint kinds. No UI yet; test with curl.
3. `apps/client` capture (glass transplant) → engine over localhost. Prove the seam: point the client at a
   second machine before building anything else.
4. One mode (`meeting`), hardcoded surface (the HUD, State A) — end-to-end: mic → distill → moments → HUD.
5. Router + second workspace. Then ledger + watchers (repo watcher first — it's the easiest evidence source).
6. Workbench (Vite, served by engine) with the full ledger. Then the block system, then the editors.

Every step ships something usable; nothing requires refactoring the step before it — the seam and the
document rule are what guarantee that.

---

## 12. Open questions

- ~~Contracts language/runtime~~ **Decided 2026-07-07: TypeScript end-to-end.** Contracts stay language-neutral
  (JSON Schema), so porting hot paths to Rust later remains possible (NanoGlass layering is the map).
- Rolling raw buffer format: single append file vs segment files (affects queue GC).
- Cross-workspace graph: separate file vs table inside a `_graph.db` — needs a decision before store work.
- Ledger watcher for "sent mail" without Gmail auth: clipboard/window heuristic first, or wait for opt-in auth?
- Block query language surface: expose the real store query API vs a small safe DSL (leaning DSL, compiled to
  store calls, so custom blocks can't degrade the DB).
