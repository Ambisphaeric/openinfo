# openinfo — implementation plan

**Status:** approved decisions baked in · 2026-07-07
**Companion to:** [ARCHITECTURE.md](./ARCHITECTURE.md) (the what); this file is the when and in-what-order.
**Decisions locked:** TypeScript end-to-end (language-neutral JSON-Schema contracts keep a Rust port open) ·
first template app = **the full openinfo HUD** · voice = **registers with dials underneath** · drift steering =
**fully configurable escalation chains** (shipped mode templates each define one).

---

## 0. Constraints that govern every phase

1. **Everything configurable is a document** (surfaces, modes, registers, fabric, flags, palettes). No phase may
   introduce user-facing config that isn't a versioned, cloneable record. This is the anti-refactor insurance.
2. **The app prepares, the human executes.** No phase ships an outward action (send/commit/reply).
3. **Feature flags are standardized from Phase 0**: a flag is a document
   `{ key, default, scope: engine|surface|mode, description }`, readable over the API, settable per user and per
   context. Every phase ships its features OFF by default behind flags until its exit criteria pass.
4. **Minimalist defaults, maximum configuration.** Default surfaces stay spare; depth lives behind the editors.
5. **Offline is a guarantee.** No phase may add a feature whose only implementation is a cloud endpoint.

---

## 1. The voice system (new contract, specified here, folded into ARCHITECTURE)

**Dials** — the atomic unit, each 0–10:

```jsonc
{ "tone": 3,          // 0 stern … 10 soft
  "warmth": 4,        // coldness … warmth (distinct from tone: a message can be soft but cool)
  "wit": 2,           // 0 literal … 10 playful
  "charm": 2,         // 0 clinical … 10 charismatic  ("low but not NO charm" = 2, not 0)
  "specificity": 9,   // 0 gestural … 10 cite-the-page
  "brevity": 8 }      // 0 expansive … 10 terse
```

**Registers** — named, saved dial vectors. Shipped set: `boardroom` (the SOC 2 profile above), `collegial`,
`warm-counsel` (serious but softer — the second option in the drift example), `sales-floor` (charm 8, tone 7,
brevity 4), `playful`. Users tweak dials and save their own registers; registers are documents, so they clone
and share like everything else.

**Binding** — contexts bind to registers: a mode declares a default (`meeting.security → boardroom`), a
workspace can override, a session can override live. Resolution order: session > workspace > mode > global.

**Consumption — dials are pre-processing variables.** Every Distill/Act prompt template interpolates the
resolved vector before the local model runs:

```
You are drafting a follow-up. Voice: specificity {{specificity}}/10, brevity {{brevity}}/10,
charm {{charm}}/10 — at charm ≤3 avoid humor entirely; at specificity ≥8 cite sources by page…
```

Template authors get the raw numbers *and* compiled guidance snippets (`{{voice.rules}}`) so small local models
aren't asked to interpret "charm 2" cold.

**The comparator (drift steering)** — the distill pass already reads the room; it additionally emits a
`detected_register` estimate per merge window. When detected drifts from bound beyond a threshold, the
**escalation chain** fires. A chain is per-mode config, fully user-defined, e.g.:

```jsonc
{ "drift": { "threshold": 3, "sustain": "90s",
  "chain": [ { "step": "glyph" },                          // status dot tints toward target
             { "step": "card", "offer": ["boardroom", "warm-counsel"] },  // two ways back, always
             { "step": "tts", "if": "audio_private" } ] } }
```

No hardcoded default behavior — but every shipped mode template includes a sensible chain, because templates
are documents and that's where opinions live.

---

## 2. Template apps (ship five, each = surface docs + mode docs + registers + a flag set)

| # | Template | Shape | Proves |
|---|---|---|---|
| 1 | **openinfo HUD** | The live-join panel (states A/B/C from the renderings) | The whole thesis — launch anchor |
| 2 | **Meeting Companion** | Meetily-shaped: transcript pane, rolling summary, follow-up draft | The distill pipeline standalone |
| 3 | **Glass Minimal** | Two-button hidden pill: ask + listen | The floor: how spare a surface can be |
| 4 | **Interview** | Diarize-on, 1m merges, question-tracking block, `boardroom` register | Voice binding + moment typing |
| 5 | **Deep Work** | Screen-heavy, mic-off, commitment-proximity block, quiet density | The router + ledger without meetings |

Templates are the openness demo: each is nothing but documents a user could have built in the editors.

---

## 3. Phases

Durations are rough, assume one lead + agent support, and overlap ~20% (a phase's polish tail runs under the
next phase's start). Cumulative to end of Phase 6: **~6 months**.

---

### Phase 0 — Contracts & scaffold (≈2 wk)

**Goal:** the schemas this repo will never have to walk back.

- Monorepo scaffold (pnpm, TS strict, `shared/contracts` package first).
- JSON-Schema + generated TS types for every record in ARCHITECTURE §3, in priority order: **commitment**,
  **surface/block/action**, **mode**, **voice (dial/register/binding/chain)**, **fabric endpoint**, **flag**,
  moment, entity, session, workspace, pin.
- Flag registry (documents + API stub). Example documents for each schema, validated in CI.
- Decide the block query DSL surface (small safe DSL compiled to store calls — per ARCHITECTURE §12 lean).

**Exit:** `pnpm test` validates every example document; a stub engine serves `/contracts` and `/flags` to curl.
**Out of scope:** any UI, any model call.

---

### Phase 1 — The seam (≈3 wk)

**Goal:** client and engine capture seam flowing over authenticated loopback before anything is built on
top; the same protocol may cross machines only through the explicit trusted HTTPS tunnel mode.

- **Engine skeleton:** api (HTTP+WS), store (loom `store` transplant + DB-file-per-workspace registry),
  bus (loom `bus`), fabric v0 (`local` + `http` endpoint kinds; slots `stt`, `llm`, `embed`), health +
  measured-benchmark endpoints (tok/s, latency — feeds envelope math later).
- **Client skeleton:** Electron shell + capture transplanted from glass (mic, screen Δ-gate,
  content-protection/hide-from-screenshare), `engine-link` with offline spool, engine address as config.
- Queue v0: raw spool + idle drain loop (no UI, no analytics — just never lose capture).

**Exit (the seam demo):** stop the engine mid-capture; client spools; restart; engine catches up exactly
once. A cross-machine variant must provision the tunnel credential and TLS boundary explicitly.
**Risks:** glass transplant friction (Electron 30 → current; SystemAudioDump + AEC submodule builds). Mitigate:
timebox a week; mic-only is an acceptable Phase-1 fallback, system audio can land in Phase 2.

---

### Phase 2 — HUD vertical (≈6 wk) — the anchor phase

**Goal:** attend a real meeting; the HUD (state A) is alive: Now line, typed Moments, Relevant-now, and a
follow-up draft ≤60s after the call. This is the demo you send a friend.

Because the HUD was chosen as the first app, a **thin index moves forward** into this phase:

- **Distill:** rolling merge (30s→2m), prompt templates with **voice interpolation (dials v1)** — registers,
  bindings, resolution order all live here even though the comparator waits for Phase 5.
- **Moments:** typed extraction (● commitment ◆ question-at-you ▲ decision ✱ artifact) riding the distill pass.
- **Index v0 (single workspace):** entity records from the same pass, recency×frequency ranking,
  relevant-now join. *No canon, no pins, no cross-workspace yet.*
- **HUD surface:** rendered **from a static surface document through the real block renderer** — no hardcoded
  layout, even though no editor exists yet. This is the deliberate down-payment on Phase 6.
- Sessions (manual start/stop; the router is Phase 3). Follow-up draft as the first Act node.
- Template #1 (openinfo HUD) and #3 (Glass Minimal — nearly free once blocks render from documents) ship.

**Exit:** live-meeting demo above, on local models only, with a register bound and visibly shaping the draft
(run the same meeting through `boardroom` and `sales-floor`; the two drafts must read differently).
**Risks:** extraction quality on 3–8B models (the #2 hard part in ARCHITECTURE §10) now sits in the critical
path. Mitigate: tight schemas + retry-at-idle via queue with `llm.smart`; accept noisy relevant-now at first —
provenance lines make noise inspectable.
**Out of scope:** router, pins, ledger, editors, drift.

---

### Phase 3 — Router, workspaces, full index (≈4 wk)

**Goal:** the day segments itself; recall gets deep.

- Context-switch detection (window title + repo path + calendar + voice presence), attribution evidence on
  every session, **one-click retroactive reroute** (moves a session between workspace DBs — the correction
  loop the router's mistakes require).
- Multi-workspace store for real; cross-workspace entity graph (edges only).
- **Canon:** reference-merging, outbound-use weighting. **Pins with ingestion:** fetch (PDF first, Google Docs
  behind an auth flag), chunk with page anchors, embed → the "p. 42 + copy bar" answer path.
- Envelope math + overflow policies wired to real measured benchmarks (queue-for-later / degrade / drop).

**Exit:** a two-workspace workday attributes correctly (mis-attributions fixable in one click); the SOC 2
pinned-PDF demo answers with a page citation.

---

### Phase 4 — Ledger, watchers, workbench (≈4 wk)

**Goal:** the living to-do with evidence, and the roomy surface behind the HUD's top-K.

- Commitment lifecycle (`open → prepared → done`), watchers: **repo watcher first** (commits/branches/PRs),
  then doc-edit and outbound-mail heuristics (clipboard/window before any Gmail auth).
- **Prepared action cards:** the Act pipeline drafts the artifact (email, excerpt, quote request) and attaches
  it; copy button; checkbox records completion. Overflow rule: HUD block shows top-K, links to workbench.
- **Workbench:** Vite app served by the engine in an authenticated browser session (another machine also
  requires the trusted HTTPS tunnel) — full ledger, session archive,
  pre-meeting brief (HUD state C logic lives engine-side, rendered both places).
- Template #5 (Deep Work) ships — it's mostly router + ledger.

**Exit:** the "did I?" flow end-to-end — promise made by voice at 10:42, commit pushed at 4:12, item closes
itself with the hash; a second promise with empty watchers surfaces in the pre-meeting brief asking "did you?"

---

### Phase 5 — The comparator: drift steering (≈3 wk)

**Goal:** the SOC 2 joke gets a gentle exit ramp.

- `detected_register` estimation per merge window (same pass, calibrated against the dial scale).
- Escalation-chain executor (glyph / card / tts steps, thresholds, sustain windows) — chains are per-mode
  documents; all five shipped mode templates get tuned chains; drift cards **always offer two ways back**
  (e.g. `boardroom` and `warm-counsel`).
- TTS slot lands in the fabric (kokoro local) as the optional chain terminus, gated on `audio_private`.

**Exit:** in a `boardroom`-bound test call, sustained joking tints the glyph, then surfaces the two-option
card; switching registers mid-session updates the interpolated prompts on the next merge window.
**Deliberately after the ledger:** steering needs trust; trust is earned by the ledger being right first.

---### Phase 6 — Openness: the editors & the gallery (≈5 wk)

**Goal:** everything you've been configuring by editing JSON becomes visual, and the gallery ships.

- **Surface WYSIWYG:** the edit-mode from the HUD artifact — reorder/collapse/remove/add blocks, block
  inspector (query, visibility, density, per-block model/register).
- **Palette designer:** visible buttons as documents — users compose their pill/bar from the action library
  (and inputs toggles: mic, screen, camera-when-it-lands).
- **Mode editors:** form view + canvas view (n8n-style) over the same mode document; register/dial editor with
  live preview ("re-draft this paragraph at charm 6").
- **Custom blocks:** sandboxed engine-served HTML (rabbithole pattern), postMessage bridge, API-only reach.
- **Template gallery:** all five apps installable/cloneable/exportable; a template is visibly nothing but
  documents (the openness proof). Flag manager UI.

**Exit:** a non-author user clones Glass Minimal, adds a pinned-doc block and a custom button, rebinds the
meeting mode to their own saved register — without touching a JSON file.

---

### Phase 7 — Expansion (ongoing, post-core)

- **Camera input** (flagged): first scopes — presence/away detection (feeds away-mentions + ledger timing),
  then document capture. Explicitly *not* always-on video distillation until the queue math proves out.
- Cloud endpoint kind in the fabric UI (Gemini Live etc., keychain auth) — enhancement, never dependency.
- Backlog analytics surface (the v0.2 rendering), diarization behind a flag, packaging/onboarding
  (the "friend installs it, configures a local model, it just starts" story), VLM slot use for screen
  understanding beyond OCR.

---

## 4. Cross-cutting workstreams (every phase)

- **Bench:** measured tok/s + latency per endpoint, stored; envelope math and analytics read only measurements,
  never vendor claims.
- **Teaching loop:** every dismiss/"not a commitment"/reroute is a labeled signal, stored per workspace, fed
  back into extraction prompts.
- **Document hygiene:** every new config type gets schema + example + gallery entry the same week it's coded.
- **Dogfood cadence:** from Phase 2 on, the lead runs openinfo in daily meetings; every phase's exit criteria
  are demoed on real workdays, not fixtures.

## 5. Risk register (top 5)

| Risk | Phase | Mitigation |
|---|---|---|
| HUD-first pulls index quality into the critical path | 2 | Thin index v0 + provenance-on-everything makes noise inspectable; retry-at-idle upgrades extractions |
| Glass transplant friction (Electron age, audio binaries) | 1 | Timebox; mic-only fallback; system audio may slip to 2 |
| Router mis-attribution poisons workspace DBs | 3 | Evidence on every session + one-click retroactive reroute shipped same phase |
| Small-model register detection is noisy → nagging | 5 | Sustain windows + thresholds; chains off by default outside bound modes; two-option cards never one |
| Editor scope creep (the historical failure mode) | 6 | Editors are forms over already-shipped documents; any editor needing a new engine capability is out of scope by definition |
