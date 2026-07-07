# openinfo — code map

**Status:** Phases 0–2 built (contracts · seam · distill/moments/index · sessions · HUD · act) · 2026-07-07
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
│  ├─ api/                      P1   http, ws, routes/ per resource
│  ├─ bus/                      P1   ← loom packages/bus
│  ├─ store/                    P1   ← loom packages/store + sqlite-vec
│  │                                 workspace-registry (DB-FILE PER WORKSPACE) · sessions (P2: manual start/stop lifecycle) · distillates/moments/entities/drafts (P2) · graph (P3) · layouts (P2)
│  ├─ fabric/                   P1   slots stt/tts/llm/vlm/ocr/embed · endpoints local|http (P1) cloud (P7)
│  │                                 bench (measured tok/s) · health (first-healthy-wins) · invoke (P2: llm openai-compat)
│  ├─ workflow/                 P2   ← loom packages/recipe · compile.ts (mode doc → DAG) — NOT built: P2 primitives wired direct at their seams; DAG deferred until multi/chained acts (see workflow/README)
│  ├─ distill/                  P2   merge · distiller · moments (typed extraction) · parse (defensive JSON, shared) · defaults/documents (template+mode docs) │ ocr (P3)
│  ├─ voice/                    P2   resolve · interpolate · documents/defaults (registers+bindings) │ P5: comparator · chains
│  ├─ index/                    P2   extract (entities) · rank (recency×frequency) · relevant (relevant-now join) │ P3: canon · ingest/ (pdf, gdoc)
│  ├─ act/                      P2   the Act primitive: draft (follow-up-draft on session end) · defaults/documents (act template) │ P3+: task-extract · nudge · exports
│  ├─ route/                    P3   detector · attribute · identity · reroute
│  ├─ ledger/                   P4   commitments · watchers/{repo,doc,mail} · prepare (action cards — builds on act/)
│  ├─ queue/                    P1   spool · drain (P2: optional distill processor · drainNow flushes before the act) │ P3: eta │ gc
│  ├─ overlay/                  P2   rules/lenses · roles · ontology (voice lives in voice/)
│  ├─ flags/                    P0   flag registry (flags are documents)
│  ├─ surfaces/                 P2   HUD surface documents (documents/defaults) · block-query compiler (query.ts: BlockQuery→store calls) │ P4: serve workbench │ P6: custom-block sandbox (rabbithole pattern)
│  └─ teach/                    P2   dismiss/reroute signals → extraction prompts (quality flywheel)
│
├─ apps/client/src/             thin Electron client — NEVER opens a database
│  ├─ main/                     P1   the Electron shell (BUILT): shell.ts (electron entry) · window-options (content-protection, always-on-top, frameless) · tray-menu (show/hide · start/end session · live indicator) · shortcuts (⌘\ hide) · engine-session (session client + WS live-state) · config · tray-icon
│  ├─ capture/                  P1   mic · screen Δ-gate · system audio + aec │ P2: calendar │ P3: focus │ P7: camera
│  ├─ engine-link/              P1   typed client from contracts · offline spool
│  └─ surfaces/                 P2   block-renderer (pure VNode, render(surfaceDoc)) · blocks/ (built-ins + glyphs) · hud/ (live controller + transport + dev-entry) │ P2-todo: settings/ │ P6: palette/ · editor/
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
| Diarization / voice→person | P7 | `engine/route/identity.ts` + `fabric` stt option |
| Google Docs pin ingestion (auth) | P3 | `engine/index/ingest/gdoc.ts` + flag `ingest.gdoc` |
| Gmail/calendar write scopes | P7+ | new `engine/connect/` module (design note first, per rule 5) |
| Cloud endpoints (Gemini Live, Anthropic) | P7 | `engine/fabric/endpoints/cloud.ts` (keychain) |
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
