# openinfo

A configurable workflow engine for your perceived reality. In the lineage of n8n / ActivePieces /
fabric — but where those pipe API payloads between nodes, openinfo pipes what you see, hear, and do
(screen, mic, calendar, repos) through model-driven passes, and every stage writes a **document you
can read, diff, edit, and hand to a friend**. It runs **local-first**: tiny models (3–30B, offline if
you want) process a lot of data fast, and low raw quality is acceptable *because* every output is
transparent, versioned, and user-editable, with a one-line *why* back to its source. The engine even
serves its own JSON Schemas, so an offline local model can write valid customizations.

Surfaces are documents. Prompts are documents. Voices/registers are documents. Feature flags are
documents. The meeting HUD you can render today is **one configuration out of thousands** you could
compose — not the product, just the first one we built.

**Status:** pre-release, mid-Phase-3, moving fast. What works today: capture spools into the engine,
a rolling-merge **distill** pass emits summaries + typed **moments** (● commitment ◆ question-at-you
▲ decision ✱ artifact) + an entity **index** with recency×frequency ranking, manual **sessions**
steer voice, the **HUD** renders entirely from a surface document through the real block renderer,
and ending a call prepares a register-shaped **follow-up draft** (the first Act node — prepared,
never sent). The **router** now watches focus signals (app, window title, repo) and auto-attributes
sessions to the right workspace, with a one-click retroactive reroute that keeps the evidence trail.
Every feature ships behind a flag, **OFF by default**. Ledger, pins, and the visual editors are
designed but not built; the workflow substrate and screen/OCR are the work in flight (see
`docs/NEXT.md` for the live queue).

---

## Quickstart

Verified from a clean tree (macOS, Node 22+, pnpm 9). Clone to a rendered HUD:

```bash
pnpm install
pnpm -r build          # contracts → engine + client (workbench is a Phase-4 scaffold)
pnpm -r test           # contracts schema-validation (51) + engine (281) + client (139)

# start the engine daemon — localhost:8787 by default, data under ~/.openinfo/data
node apps/engine/dist/main.js            # OPENINFO_PORT / OPENINFO_DATA to override
```

With the engine up, everything is the typed HTTP API — the client never touches a database:

```bash
curl localhost:8787/health
curl localhost:8787/flags                     # every flag, all default:false
curl localhost:8787/registers                 # the 5 built-in voice registers
curl localhost:8787/layouts/surfaces                     # every HUD layout (seeded + yours)
curl localhost:8787/layouts/surfaces/surf-openinfo-hud   # the HUD, as a document
# edit it with forms (reorder/add/remove blocks, top, collapsed, clone) — no JSON by hand:
open http://localhost:8787/settings/hud-layout?surface=surf-openinfo-hud    # the HUD-layout editor (also under Settings → HUD layout)

# start a session, then ask the HUD's relevant-now block for data
curl -sX POST localhost:8787/sessions -H 'content-type: application/json' \
  -d '{"workspaceId":"demo","modeId":"mode-meeting","title":"first run"}'
curl -sX POST localhost:8787/query -H 'content-type: application/json' \
  -d '{"source":"relevant-now","params":{"workspace":"demo"},"top":4}'
```

**Render the HUD — the menu-bar app** (the real client shell: a frameless, always-on-top,
content-protected window, invisible to screen share, hosting the HUD):

```bash
pnpm --filter @openinfo/client start     # builds, then launches electron .
# OPENINFO_ENGINE_URL / OPENINFO_PORT point it at the daemon (default http://127.0.0.1:8787)
# OPENINFO_MIC=0 disables microphone capture (default ON while a session is live)
# OPENINFO_SYSTEM_AUDIO=0 disables system-audio capture ("them" — the far side of a call, captured off a
#   BlackHole-like virtual input; default ON, but a no-op unless such a device is present + its output is
#   routed through it — see apps/client/src/capture/README.md for the Multi-Output-Device / headphones setup)
```

The window opens **hidden** (like Glass). Reveal it with **⌘\\** or the menu-bar (tray) icon → **Show
HUD**. The tray also toggles the session — **Start Session / End Session** — and shows whether one is
live (**● rec** while the mic is capturing); **Quit** exits. While a session is live the client captures
the **microphone** and streams timed audio chunks to the engine (macOS will ask for mic permission the
first time — click Allow; denial disables audio only, the session/text path is unaffected). No session
live ⇒ nothing is captured. (Screen capture is still pending.)

**Or build a real, double-clickable menu-bar app** (a proper macOS `.app` bundle — this is what makes the
OS ask for **microphone / Local Network permission under the app's own name**; the `electron .` dev run
above is unsigned and has no bundle identity, so macOS attributes its requests to the launching terminal
and the app's own dialogs never appear):

```bash
pnpm --filter @openinfo/client package
# → apps/client/release/openinfo-darwin-arm64/openinfo.app  (arm64, ad-hoc signed with `codesign -s -`)

open apps/client/release/openinfo-darwin-arm64/openinfo.app     # or double-click it in Finder
```

The packaged app reads its engine URL from **`~/.openinfo/client.json`** (a double-clicked app inherits no
env), else an env var, else `http://127.0.0.1:8787`:

```bash
echo '{"engineUrl":"http://127.0.0.1:8787"}' > ~/.openinfo/client.json   # optional; env still overrides
```

On first run, if a model isn't set up yet the app opens **`/settings`** in your browser once (landing on
Get started). If the mic is
denied, the tray shows a **"Microphone blocked — Open Settings…"** item that jumps to the right pane; if the
engine can't be reached the tray says so (and hints at Local Network permission for a non-local engine).
**Ad-hoc signing caveat:** the identity changes on every `package`, so macOS re-prompts for permissions after
a rebuild. **Accessibility** (for window-title context detection) is granted per-app in System Settings →
Privacy & Security → Accessibility — there is no Info.plist key for it. (Dev/ad-hoc only — no notarization,
auto-update, or Windows/Linux packaging.)

**Or render it in a plain browser** (same HUD, same transport — handy without Electron):

```bash
pnpm --filter @openinfo/client build
npx serve apps/client          # or any static server
# open http://localhost:3000/dev-hud.html?engine=http://127.0.0.1:8787
```

Either way the HUD renders against a bare engine — the Now line, the block stack, empty explainable
blocks. That is the honest state, not a broken one: the data a block shows is gated upstream.

**To see distill / moments / index / the follow-up draft actually run**, two things must be true.
First, flip the flags (they're documents; flip over the API, effective without a restart):

```bash
for f in distill.enabled distill.moments distill.index act.enabled; do
  curl -sX PUT localhost:8787/flags/$f -H 'content-type: application/json' \
    -d "{\"key\":\"$f\",\"default\":true,\"scope\":\"engine\",\"description\":\"on\"}"; done
```

Second — **the distill pass needs an OpenAI-compatible LLM endpoint** (Ollama, LM Studio, mlx). The
`llm` slot ships empty. **Open `/settings` — its Get started section detects your local model servers and
offers one button.** On first run the page leads with a Get-Started capability checklist (Hearing ·
Thinking · Reading · Speaking): it probes the well-known local servers (LM Studio :1234, Ollama :11434,
kokoro :8880, common whisper ports), reads what each has actually loaded (`GET /v1/models`), classifies
every model by name, and shows the result — "Found LM Studio with 36 models". Click **Use this setup** and
it writes and activates a `config-1` profile for you. No ports or model trivia. (The menu-bar tray opens
`/settings` too, and flags it "⚠ Set up models…" while the llm slot is empty.) **No server at all?** The nothing-found
state offers **"Download a starter model"** — the engine fetches a small vetted model (llama.cpp for
chat, whisper.cpp for audio) into its data dir and runs it for you, so tier zero still reaches a working
setup. If the runtime binary is missing it shows the exact `brew install` line instead of a dead end.

Third — **try it, right there.** Once a model is configured, `/settings` has a **Try it** section: type a
sentence (or speak, if you have a transcription server) and watch openinfo turn it into a typed moment,
live — glyph, text, and the one-line provenance (`via <endpoint> · <model>`). This is the product, not a
test button. Your click turns on distillation (it says so; turn it back off any time under Features), and
if nothing comes back the card tells you exactly where it stopped. Verified end-to-end against real
LM Studio: "Let us ship the onboarding slice on Thursday…" came back as a `commitment` moment in ~17s on a
warm 8B.

```bash
open http://localhost:8787/settings       # macOS; or just visit it in any browser (/setup 301s here)
curl localhost:8787/fabric/discover       # the same detection, as JSON (servers + a config-1 suggestion)
```

**Advanced setup** on the same page (and the raw routes below) is still there when you want full control —
name/clone/activate profiles, add slot→endpoint rows across hosts, wire a key by reference, and Test each
endpoint (reachable · latency). The page is only composing these routes:

```bash
curl -sX PUT localhost:8787/fabric -H 'content-type: application/json' -d '{"slots":{
  "stt":[],"tts":[],"vlm":[],"ocr":[],"embed":[],
  "llm":[{"name":"llm.local","kind":"http","url":"http://127.0.0.1:11434",
          "model":"llama3.2:3b","api":"openai-compat"}]}}'
```

Without an endpoint, capture is still accepted and durably spooled; the drain simply re-queues it
(retry-at-idle — nothing is ever lost) and no moments appear. With one, POST a text `CaptureChunk`
to `/capture/mic` and the drain distills it into moments/entities the HUD then surfaces. End the
session (`POST /sessions/:id/end`) and — with `act.enabled` on — a follow-up draft is prepared from
the session's summaries within seconds; fetch it at `GET /drafts?workspace=default&session=<id>`.

**Your fabric is a saveable, switchable document.** `GET`/`PUT /fabric` is the *active profile* — a
named, cloneable slot→endpoint map. Ship different rigs (an 8B in LM Studio; a 27B on another host + a
4B OCR box + parakeet STT here / TTS there) as profiles and switch between them:

```bash
curl localhost:8787/fabric/profiles                          # lm-studio-local, ollama-local, remote-http-template (seeded, inert)
curl -sX POST localhost:8787/fabric/profiles/lm-studio-local/activate   # its map is now the live fabric
```

Remote endpoints remember their host and reference a key by name — never a value. Set the value once
(write-only; it lives in a chmod-600 store, never in a document, GET response, or event):

```bash
curl -sX PUT localhost:8787/fabric/secrets/remote-llm-key -H 'content-type: application/json' -d '{"value":"sk-…"}'
curl localhost:8787/fabric/secrets                            # [{"ref":"remote-llm-key"}] — refs only, never values
```

The key is injected as `Authorization: Bearer …` only at invoke time; a missing key just makes that
endpoint fall through to the next. All of this — profiles, endpoints, keys, per-endpoint testing —
is what the **`/settings`** page above drives (Models group: Endpoints · Profiles · Keys · Local
runtimes), so you rarely need the raw curls. (Localhost-only, no
auth yet — a P7 concern.)

---

## How it's put together

```
CLIENT (thin)  ──HTTP + WS──▶  ENGINE (daemon)          localhost by default,
Electron/browser              api · distill · index      any host:port by config
never opens a DB              voice · surfaces · store · queue · fabric
        ╲                                    │
         ╲── shared/contracts ──────────────╱   the ONLY seam; nothing crosses it untyped
```

Two rules make the rest possible:

- **The client never touches a database.** Every pixel came through the API — which is what makes the
  backend a config option, custom blocks safe, and workspace isolation structural.
- **Only `engine/store` opens a DB handle**, and it's **one SQLite file per workspace**. Delete,
  export, or encrypt a workspace by handling one file. Isolation isn't a `WHERE` clause.

The deep docs, each with a job:

- **`ARCHITECTURE.md`** — the *what* (the product's own vocabulary: surfaces/blocks, modes, registers/dials, the fabric).
- **`IMPLEMENTATION.md`** — the *when* (phases 0–7, exit criteria, current status).
- **`CODE_MAP.md`** — the *where* (the tree, dependency rules, where unbuilt features will land).
- **`CONTRIBUTING.md`** — the *how* (the tier system below).
- **`docs/PHASE1-NOTES.md` / `PHASE2` / `PHASE3`** — every decision and deviation as each slice landed.
- **`docs/NEXT.md`** — the live session queue: what's in flight, what's next, and the founder decisions behind each.
- **`design/renderings/`** — the versioned HTML mockups; the design source of truth for surfaces.

---

## Hack it — the kit

Because everything configurable is a document, customization is tiered by *surface*, and the low
tiers are safe for models — including small local ones — to write, because a wrong document simply
cannot ship (JSON-Schema validation is the gate). See `CONTRIBUTING.md` for the full table.

| Tier | You change | Who | Gate |
|---|---|---|---|
| **A** | documents: surfaces, registers, templates, flags, pins | any capable model or human, via shipped `skills/` | JSON-Schema validation |
| **B** | code-by-recipe: a new block type, watcher, fabric runtime | ~30B local models on rails, humans | recipe + types + tests + evals |
| **C** | core: `shared/contracts`, `store`, `route`, the seam | humans + frontier models | review + design note first |

The kit itself: **`templates/`** is the gallery — documents only, no code (that's the openness proof;
openinfo-hud and glass-minimal ship today). **`skills/`** are recipes a local model follows to
customize safely (e.g. `add-a-block`). **`design/renderings/`** is where a surface starts life.

A taste of a **Tier-A edit** — the entire Glass Minimal template is two blocks:

```jsonc
{ "id": "surf-glass-minimal", "name": "Glass Minimal", "context": "any", "version": 1,
  "stack": [
    { "block": "now" },
    { "block": "moments", "collapsed": true,
      "query": { "source": "moments", "params": { "session": "current" }, "top": 5 } } ] }
```

`GET` a surface, splice a block into `stack`, `PUT` it back — the engine revalidates and bumps the
version (it keeps every prior one). Two documents, one renderer, two different layouts. Sharing your
setup is sending a file.

---

## Not here yet (designed, not built — see `IMPLEMENTATION.md` and `docs/NEXT.md`)

- **Workflow substrate** (P4, in flight) — user-composed processing chains as documents; today the
  distill→index→act order is fixed wiring, and this is the piece that makes it yours to arrange.
- **Screen capture + OCR/VLM** (P4, in flight) — the slots and contracts exist; nothing invokes them yet.
- **Richer routing signals** (staged) — focus landed; calendar next, then topic-drift, so a
  marketing→sales switch is caught even when the same call window stays focused.
- **Earned canon & pins** (P3) — outbound-use weighting, page-anchored PDF ingestion, the "p. 42 + copy bar" answer.
- **Ledger & watchers** (P4) — commitments that auto-close on evidence (a commit hash, a sent thread).
- **Workbench** (P4) — the roomy Vite surface behind the HUD's top-K; currently a scaffold.
- **The editors & gallery** (P6) — surface WYSIWYG, mode canvas, dial editor, custom sandboxed blocks.
- **Drift steering** (P5), **camera / cloud endpoints** (P7).

Everything above already has a home in `CODE_MAP.md`, so no later phase has to invent one.
</content>
</invoke>
