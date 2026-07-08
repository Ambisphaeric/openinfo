# openinfo — code map

**Status:** Phases 0–2 built (contracts · seam · distill/moments/index · sessions · HUD · act · fabric profiles/secrets · GET /setup · onboarding discovery + Get-Started lens · the "watch it become a moment" Try-it loop on /setup · engine-managed local runtimes / tier zero · client system-audio capture (BlackHole detect-and-guide)) · 2026-07-08
**Reads with:** [ARCHITECTURE.md](./ARCHITECTURE.md) (the what) · [IMPLEMENTATION.md](./IMPLEMENTATION.md) (the when)
This file is the **where** — including where features that don't exist yet will land, so no later phase ever
has to invent a home (the historical failure mode).

---

## 1. The tree

```
openinfo/
├─ shared/contracts/            P0   the only shared dependency; typed seam
│  ├─ src/records/              P0   commitment, moment, entity, session, workspace, pin
│  ├─ src/config/               P0   surface(block/action), mode, voice, fabric, flag
│  ├─ src/api/                  P0   HTTP routes + WS events (names, payloads)
│  ├─ src/query/                P0   block query DSL (grammar, types)
│  └─ schemas/                  P0   generated JSON Schema — language-neutral (Rust-portable)
│
├─ apps/engine/src/             the daemon (localhost default, any host:port by config)
│  ├─ api/                      P1   http.ts (all route handlers, one dispatcher) · ws · json/validation/defaults
│  ├─ bus/                      P1   ← loom packages/bus
│  ├─ store/                    P1   ← loom packages/store + sqlite-vec
│  │                                 workspace-registry (DB-FILE PER WORKSPACE) · sessions (P2: manual start/stop lifecycle) · distillates/moments/entities/drafts (P2) · graph (P3) · layouts (P2)
│  ├─ fabric/                   P1   slots stt/tts/llm/vlm/ocr/embed · endpoints/local.ts (P2 tier zero: LocalRuntimeManager) · http/cloud inline in invoke/health
│  │                                 bench (measured tok/s; local stays stubbed — real numbers need hardware) · health (first-healthy-wins; reports local spawn state) · invoke (P2: llm chat-completions · stt /v1/audio/transcriptions multipart — both openai-compat, first-healthy-wins; keyRef→Authorization: Bearer at invoke time; local branch spawns the runtime + speaks its surface — whisper.cpp /inference)
│  │                                 profiles (named/versioned/cloneable slot-maps; active = live fabric; GET/PUT /fabric = active view) · secrets (SecretStore interface; v0 chmod-600 JSON in secrets/, keychain P7 — write-only API, refs never values)
│  │                                 discover (P2: probe-list + capability-map docs → GET /fabric/discover: parallel probe /v1/models, classify by name, synthesize a config-1 suggestion — smaller-model-first ranking; LAN sweep later)
│  │                                 local runtimes (P2 tier zero: endpoints/local.ts spawn/health/kill/bounded-restart of llama.cpp/whisper.cpp · local-models.ts download+resume+size-check · local-{documents,defaults}.ts starter catalog · GET /fabric/local/models · POST /fabric/local/download)
│  ├─ workflow/                 P2   ← loom packages/recipe · compile.ts (mode doc → DAG) — NOT built: P2 primitives wired direct at their seams; DAG deferred until multi/chained acts (see workflow/README)
│  ├─ distill/                  P2   merge · distiller · transcribe (audio→text pre-distill drain stage via stt slot; mic="me"/system-audio="them" speaker split) · moments (typed extraction) · parse (defensive JSON, shared) · defaults/documents (template+mode docs) │ ocr (P3)
│  ├─ voice/                    P2   resolve · interpolate · documents/defaults (registers+bindings) │ P5: comparator · chains
│  ├─ index/                    P2   extract (entities) · rank (recency×frequency) · relevant (relevant-now join) │ P3: canon · ingest/ (pdf, gdoc)
│  ├─ act/                      P2   the Act primitive: draft (follow-up-draft on session end) · defaults/documents (act template) │ P3+: task-extract · nudge · exports
│  ├─ route/                    P3   detector · attribute · identity · reroute (BUILT: detector.ts — pure sustain-window context-switch detection over FocusSignals+hints; attribute.ts — the Attributor auto-starts/switches sessions behind route.detect, emits session.switched; hints.ts — workspace-hints docs; focus.ts — focus-chunk decode; reroute.ts — one-click retroactive session move + session.rerouted, the correction/teaching signal. identity.ts is P7)
│  ├─ ledger/                   P4   commitments · watchers/{repo,doc,mail} · prepare (action cards — builds on act/)
│  ├─ queue/                    P1   spool · drain (P2: optional distill processor · drainNow flushes before the act) │ P3: eta │ gc
│  ├─ overlay/                  P2   rules/lenses · roles · ontology (voice lives in voice/)
│  ├─ flags/                    P0   flag registry (flags are documents)
│  ├─ surfaces/                 P2   HUD surface documents (documents/defaults) · block-query compiler (query.ts: BlockQuery→store calls) · setup/ (GET /setup — the first ENGINE-served surface: forms over profile+secret docs; the Get-Started capability lens over /fabric/discover) │ P4: serve workbench │ P6: custom-block sandbox (rabbithole pattern)
│  └─ teach/                    P2   dismiss/reroute signals → extraction prompts (quality flywheel)
│
├─ apps/client/src/             thin Electron client — NEVER opens a database
│  ├─ main/                     P1   the Electron shell (BUILT): shell.ts (electron entry) · window-options (content-protection, always-on-top, frameless) · tray-menu (show/hide · start/end session · live indicator · permission fix-it items) · shortcuts (⌘\ hide · Settings deep-links) · engine-session (session client + WS live-state) · config (env > ~/.openinfo/client.json > defaults) · tray-icon · permission-help (Settings deep-links + LAN classify) · context-health (Accessibility-hint tracker) · first-run (open /setup once) + first-run-store · scripts/package.mjs (→ ad-hoc-signed release/openinfo.app; `pnpm package`)
│  ├─ capture/                  P1   mic (BUILT: hidden-window getUserMedia → webm segments → /capture/mic, session-gated) · system-audio (BUILT: BlackHole detect-and-guide — 2nd getUserMedia on the virtual input in the SAME hidden window → /capture/system-audio="them"; native CoreAudio tap is the designed future, see ARCHITECTURE §8) · screen Δ-gate + aec │ P2: calendar │ focus (P3, BUILT: main-process osascript poll of the frontmost app/window → redacted FocusSignal → /capture/focus, session-INDEPENDENT, gated on route.detect flag + OPENINFO_FOCUS opt-out; ephemeral, never spooled) │ P7: camera
│  ├─ engine-link/              P1   typed client from contracts · offline spool
│  └─ surfaces/                 P2   block-renderer (pure VNode, render(surfaceDoc)) · blocks/ (built-ins + glyphs) · hud/ (live controller + transport + dev-entry) │ (model setup is ENGINE-served at GET /setup — the tray opens it in the browser, not a client settings pane) │ P6: palette/ · editor/
│
├─ apps/workbench/src/          P4   Vite app served BY THE ENGINE (any browser, any machine)
│                                    ledger · archive · brief │ P6: explore (canvas) │ P7: analytics
│
├─ templates/                   P2+  the gallery — DOCUMENTS ONLY, no code (the openness proof)
├─ skills/                      P2+  shipped customization recipes a local LLM can follow (Tier A)
├─ design/renderings/           —    versioned HTML mockups (design source of truth for surfaces)
├─ docs/                        —    DESIGN-CRITIQUE (100-person org amendments; capability tiers T0–T3)
├─ spikes/                      any  throwaway proofs — never importable (see spikes/README.md)
└─ tools/                       P0   schema-gen · bench harness · fixtures (capture record/replay) · evals (per-tier quality scoring, Phase-0-adjacent)
```

## 2. Dependency rules (the ones that prevent the refactor spiral)

1. `apps/*` depend on `shared/contracts` and **nothing else in the repo**. Client never imports engine;
   workbench never imports either — they meet only at the API.
2. Only `engine/store` opens a database handle. `route/` asks store to move a session; `index/` asks store to
   write an entity. Workspace isolation is enforced by one module, so it cannot be reached around.
3. `templates/` contains no code. If a template "needs" code, a block type is missing — add it to the engine
   and keep the template a document.
4. `spikes/` is not a workspace package and is banned from imports (CI-enforced). Spikes graduate by being
   **rewritten** under `apps/` against contracts — never copy-pasted.
5. New feature → find its row in §3. If it has no row, it gets a design note in ARCHITECTURE.md *before* code.

## 3. Where future features land (so nothing invents a home later)

| Future feature | Phase | Home |
|---|---|---|
| Camera input (presence → doc capture) | P7 | `client/capture/camera.ts` + flag `capture.camera` |
| System-audio native tap (no user routing) | future | `client/capture/audio-tap/` — a CoreAudio process-tap / ScreenCaptureKit-audio native module (macOS 14.2+), written from source under review (route (b), ARCHITECTURE §8). Drops behind the same source-agnostic capture controller/protocol/chunk path built in the BlackHole slice — swaps only *how the 2nd stream opens*. A trustworthy prebuilt module (route (c)) is its shortcut; the inherited SystemAudioDump blob (d) stays rejected (fresh code only) |
| Diarization / voice→person | P7 | `engine/route/identity.ts` + `fabric` stt option |
| Google Docs pin ingestion (auth) | P3 | `engine/index/ingest/gdoc.ts` + flag `ingest.gdoc` |
| Gmail/calendar write scopes | P7+ | new `engine/connect/` module (design note first, per rule 5) |
| Cloud endpoints (Gemini Live, Anthropic) | P7 | `engine/fabric/endpoints/cloud.ts` (keychain) |
| Fabric profiles + secrets (this slice) | P2 | `engine/fabric/{profiles,secrets}.ts` + profile/secret routes; live fabric = active profile |
| First-run / fabric setup page (forms over profile+secret docs) | P2 (built) | `engine/surfaces/setup/` — GET /setup, ENGINE-served forms over the profile+secret routes (deviates from the earlier `client/surfaces/setup/` guess: served by the engine like the workbench §6, not a client webview; the tray opens it in the browser). No new engine capability. |
| Onboarding discovery + Get-Started lens (this slice) | P2 (built) | `engine/fabric/discover.ts` + probe-list/capability-map seed docs; `GET /fabric/discover` (DiscoverResult); the capability lens + one-button "Use this setup" in `engine/surfaces/setup/` (composes the existing profile routes — no new write semantics) |
| Say-something verification loop (slice b) | P2 (built) | `engine/surfaces/setup/` — the Try-it card on `/setup` ("type/speak → watch it become a moment", live off the `moment.created` WS event). REVISED home: engine-served browser page, NOT the client (the browser owns the `getUserMedia` mic prompt; works for the remote-engine workflow too). Composes existing routes only (flags/sessions/capture/WS) — no new engine capability |
| Engine-managed local runtimes / tier zero (slice c) | P2 (built) | `engine/fabric/endpoints/local.ts` (`LocalRuntimeManager`: discover binary + spawn/ready/health/kill/bounded-restart for llama.cpp/whisper.cpp) + `local-models.ts` (download/resume/size-check) + `local-{documents,defaults}.ts` (starter catalog). invoke/health ride `local` on the existing seams (llm reuses the http chat path; stt speaks whisper.cpp's `/inference`). Routes `GET /fabric/local/models` + `POST /fabric/local/download`; the nothing-found lens offers "Download a starter model" → writes a `local` endpoint into config-1 via the existing profile routes. mlx/ollama/paddle/coreml are future specs (CONTRIBUTING recipe) |
| LAN sweep discovery (with permission) | future | `engine/fabric/discover.ts` — a consent-gated subnet sweep (cross-host rigs). Blocked on macOS Local-Network TCC (GUI-domain LaunchAgent; see ARCHITECTURE §8 platform note) |
| macOS Keychain secret store | P7 | `engine/fabric/secrets.ts` — `KeychainSecretStore` behind the `SecretStore` interface (drop-in for the v0 file) |
| Drift steering (comparator + chains) | P5 | `engine/voice/{comparator,chains}.ts`; card/glyph = HUD blocks |
| TTS whisper (chain terminus) | P5 | `fabric` tts slot + chain step `tts` |
| Explore canvas (lenses, branches) | P6 | `workbench/explore/` + `engine/surfaces/custom-blocks.ts` |
| Palette designer (buttons, input toggles) | P6 | `client/surfaces/palette/` over action documents |
| Surface WYSIWYG / mode canvas / dial editor | P6 | `client/surfaces/editor/` — forms over documents, no new engine capability allowed |
| Backlog analytics surface | P7 | `workbench/analytics/` reading `engine/queue/eta` |
| Custom user blocks (HTML, sandboxed) | P6 | `engine/surfaces/custom-blocks.ts` + client webview host |
| Mobile / second-screen readouts | unplanned | a new `apps/*` consumer of the same API — the seam already permits it |
| Rust hot paths (if ever needed) | unplanned | replace an engine module behind its contract; `shared/contracts/schemas/` is the port surface |

## 4. Spikes — what they are and how they bend the plan

A **spike** is a throwaway proof that answers exactly one question, in hours, in `spikes/`, with none of the
production rules applied (hardcode anything, skip types, no tests). It is deleted or graduated-by-rewrite;
its output is an *answer*, recorded as a paragraph in the relevant phase doc.

Standing spike list (each retires a named risk from IMPLEMENTATION §5):

| Spike | Question | Retires |
|---|---|---|
| `seam-echo` | client on machine A → engine on machine B, capture round-trip + offline spool | P1 risk |
| `glass-capture` | does glass's mic/screen/audio transplant build on current macOS/Electron? | P1 risk |
| `extract-quality` | record 10 min of a real meeting (fixtures tool), run 3 local models over the moment/entity schemas — which is usable? | P2 risk |
| `delta-gate` | screenshot Δ-diff: threshold vs OCR cost on real screen activity | P2/P3 |
| `register-detect` | can a small model score detected charm/wit vs the dial scale at all? | P5 risk |
| `sandbox-bridge` | postMessage API-allowlist webview: can a custom block be both useful and contained? | P6 |

### The honest recalibration you asked for

You're right: the first slice is **hours, not days**. The 6-month figure in IMPLEMENTATION.md conflates two
different clocks, and it's worth splitting them permanently:

- **Construction time** — writing the code. With agent-driven development this compresses ~10×: the Phase 1
  seam is a day-or-two build; the Phase 2 HUD vertical is a week-scale build, not six.
- **Convergence time** — the part that does not compress: dogfooding against *real* workdays. Extraction
  quality, router attribution, register detection, drift thresholds — these are tuned against lived meetings,
  and a week of calendar time contains only a week of meetings. Exit criteria like "attend a real meeting,
  trust the ledger" are experiential, not constructional.

Revised expectation per phase: **demo-able in days, trustworthy in weeks.** The phase *order* and *exit
criteria* in IMPLEMENTATION.md stand unchanged — what changes is that construction stops being the bottleneck
after week one, and the critical path becomes fixture data + dogfood cycles. That is why `tools/fixtures`
(record a meeting once, replay it deterministically) is in the tree at P0-priority: it converts convergence
time into regression tests and is the single highest-leverage tool in the repo.

Practical cadence this implies: run spikes `seam-echo`, `glass-capture`, and `extract-quality` in the first
days (they are cheap and they de-risk the two riskiest phases before any production code hardens); build
Phases 0–2 as fast as agents allow; then let the calendar do what only it can — accumulate real sessions —
while construction runs ahead on Phases 3–4 behind flags.
