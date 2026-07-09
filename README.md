# openinfo

openinfo is a local-first workflow engine with a thin client. It captures what you see and hear
(screen, mic, and related signals), runs it through model-driven passes, and writes each result as a
document you can read, diff, edit, and share. The pipeline is **capture → distill → moments / entities
→ surfaces**, and every stage emits a typed document with a one-line *why* back to its source.

It runs local-first: small models (3–30B, offline if you want) process the stream, and modest raw
quality is acceptable because every output is transparent, versioned, and editable. Everything
user-configurable — surfaces, prompts, voice registers, feature flags — is a **versioned JSON
document**, validated against a schema the engine serves, so even an offline local model can write a
valid customization. The meeting HUD you can render today is one configuration the substrate can
express, not the product itself.

Two structural rules:

- **The client never touches a database.** Every pixel it shows came through the typed HTTP/WS API,
  which is what makes the backend a config option and workspace isolation structural.
- **Only `engine/store` opens a database handle**, and it is **one SQLite file per workspace**.
  Delete, export, or encrypt a workspace by handling a single file — isolation is not a `WHERE` clause.

**Status:** pre-release. Working today: capture spools into the engine; a rolling-merge distill pass
emits summaries, typed moments (commitment, question, decision, artifact), and an entity index ranked
by recency × frequency; sessions steer voice; the HUD renders entirely from a surface document; ending
a session prepares a follow-up draft (prepared, never sent); and the router attributes sessions to a
workspace from focus signals. Every feature ships behind a flag, **off by default**. The workflow
substrate and screen/OCR are the work in flight.

```
CLIENT (thin)  ──HTTP + WS──▶  ENGINE (daemon)          localhost by default,
Electron/browser              api · distill · index      any host:port by config
never opens a DB              voice · surfaces · store · queue · fabric
        ╲                                    │
         ╲── shared/contracts ──────────────╱   the ONLY seam; nothing crosses it untyped
```

---

## Build and run

Requires Node 22+ and pnpm 9 (macOS).

```bash
pnpm install
pnpm -r build                  # contracts → engine + client
pnpm -r test                   # contracts + engine + client suites

# engine daemon — localhost:8787 by default, data under ~/.openinfo/data
node apps/engine/dist/main.js  # OPENINFO_PORT / OPENINFO_DATA override the port and data dir
```

With the engine up, everything is the typed HTTP API — the client never touches a database:

```bash
curl localhost:8787/health
curl localhost:8787/flags                                # every flag, all default:false
curl localhost:8787/registers                            # the built-in voice registers
curl localhost:8787/layouts/surfaces                     # every HUD layout (seeded + yours)
curl localhost:8787/layouts/surfaces/surf-openinfo-hud   # the HUD, as a document
```

---

## Render the HUD

**Menu-bar app (dev run).** A frameless, always-on-top, content-protected window (invisible to screen
share) that hosts the HUD:

```bash
pnpm --filter @openinfo/client start   # builds, then launches electron .
# OPENINFO_ENGINE_URL / OPENINFO_PORT point it at the daemon (default http://127.0.0.1:8787)
# OPENINFO_MIC=0            disables microphone capture (default ON while a session is live)
# OPENINFO_SYSTEM_AUDIO=0   disables system-audio capture (the far side of a call, off a BlackHole-like
#                           virtual input; see apps/client/src/capture/README.md for the routing setup)
```

The window opens hidden (like Glass). Reveal it with **⌘\\** or the tray icon → **Show HUD**. The tray
toggles the session (**Start Session / End Session**) and shows **● rec** while the mic is capturing;
**Quit** exits. While a session is live the client captures the microphone and streams timed audio
chunks to the engine (macOS asks for mic permission the first time; denial disables audio only). No
session live means nothing is captured. Screen capture is still pending.

**Packaged app.** A proper macOS `.app` bundle is what makes the OS attribute microphone / Local
Network prompts to the app itself (the `electron .` dev run is unsigned, so macOS attributes its
requests to the launching terminal):

```bash
pnpm --filter @openinfo/client package
# → apps/client/release/openinfo-darwin-arm64/openinfo.app  (arm64, ad-hoc signed with `codesign -s -`)
open apps/client/release/openinfo-darwin-arm64/openinfo.app
```

A packaged app inherits no env, so it reads its engine URL from `~/.openinfo/client.json`, else an env
var, else `http://127.0.0.1:8787`:

```bash
echo '{"engineUrl":"http://127.0.0.1:8787"}' > ~/.openinfo/client.json   # optional; env still overrides
```

Ad-hoc signing changes identity on every `package`, so macOS re-prompts for permissions after a
rebuild. This is dev/ad-hoc only — no notarization, auto-update, or Windows/Linux packaging.

**Plain browser** (same HUD, same transport, no Electron):

```bash
pnpm --filter @openinfo/client build
npx serve apps/client   # then open http://localhost:3000/dev-hud.html?engine=http://127.0.0.1:8787
```

The HUD renders against a bare engine as the Now line and an empty block stack — the honest state, not
a broken one, since the data a block shows is gated upstream.

---

## Configure models

The distill pass needs an OpenAI-compatible LLM endpoint (Ollama, LM Studio, mlx); the `llm` slot ships
empty. Open `/settings` — its Get started section probes well-known local servers (LM Studio, Ollama,
kokoro, common whisper ports), reads what each has loaded (`GET /v1/models`), classifies models by name,
and offers one button to write and activate a `config-1` profile. If nothing is found it offers to
download a small vetted starter model, or prints the exact `brew install` line when a runtime is missing.

```bash
open http://localhost:8787/settings   # or visit it in any browser (/setup 301s here)
curl localhost:8787/fabric/discover   # the same detection, as JSON (servers + a config-1 suggestion)
```

Your fabric is a saveable, switchable document. `GET`/`PUT /fabric` is the active profile — a named,
cloneable slot→endpoint map. Ship different rigs as profiles and switch between them:

```bash
curl localhost:8787/fabric/profiles                                     # seeded + yours
curl -sX POST localhost:8787/fabric/profiles/lm-studio-local/activate   # its map is now live
```

Remote endpoints reference a key by name, never a value. Set the value once (write-only; stored in a
chmod-600 file, never in a document, GET response, or event) and it is injected as `Authorization:
Bearer …` only at invoke time:

```bash
curl -sX PUT localhost:8787/fabric/secrets/remote-llm-key -H 'content-type: application/json' -d '{"value":"sk-…"}'
curl localhost:8787/fabric/secrets   # [{"ref":"remote-llm-key"}] — refs only, never values
```

Endpoints, profiles, keys, and per-endpoint testing are all driven by the `/settings` page, so you
rarely need the raw curls. Localhost-only, no auth yet (a later-phase concern).

---

## See the pipeline run

Flip the relevant flags (they are documents; changes take effect without a restart):

```bash
for f in distill.enabled distill.moments distill.index act.enabled; do
  curl -sX PUT localhost:8787/flags/$f -H 'content-type: application/json' \
    -d "{\"key\":\"$f\",\"default\":true,\"scope\":\"engine\",\"description\":\"on\"}"; done
```

Then `/settings` has a **Try it** section: type or speak a sentence and watch openinfo turn it into a
typed moment live — glyph, text, and the one-line provenance (`via <endpoint> · <model>`). Or drive it
over the API: POST a text `CaptureChunk` to `/capture/mic` and the drain distills it into
moments/entities the HUD surfaces. Without an endpoint, capture is still accepted and durably spooled
(retried at idle — nothing is lost); no moments appear until an endpoint exists. End a session
(`POST /sessions/:id/end`) with `act.enabled` on and a follow-up draft is prepared from the session's
summaries; fetch it at `GET /drafts?workspace=default&session=<id>`.

---

## Configuration is documents

Everything configurable is a document, so customization is tiered by surface and the low tiers are safe
for models — including small local ones — to write, because a document that fails JSON-Schema
validation cannot ship. See `CONTRIBUTING.md` for the full table.

| Tier | You change | Who | Gate |
|---|---|---|---|
| **A** | documents: surfaces, registers, templates, flags, pins | any capable model or human, via shipped `skills/` | JSON-Schema validation |
| **B** | code-by-recipe: a new block type, watcher, fabric runtime | ~30B local models on rails, humans | recipe + types + tests + evals |
| **C** | core: `shared/contracts`, `store`, `route`, the seam | humans + frontier models | review + design note first |

`templates/` is the gallery (documents only, no code). `skills/` are recipes a local model follows to
customize safely. `design/renderings/` is where a surface starts life. A Tier-A edit — the entire Glass
Minimal template is two blocks:

```jsonc
{ "id": "surf-glass-minimal", "name": "Glass Minimal", "context": "any", "version": 1,
  "stack": [
    { "block": "now" },
    { "block": "moments", "collapsed": true,
      "query": { "source": "moments", "params": { "session": "current" }, "top": 5 } } ] }
```

`GET` a surface, splice a block into `stack`, `PUT` it back — the engine revalidates and bumps the
version (it keeps every prior one). Sharing your setup is sending a file.

---

## Where the docs live

- **`ARCHITECTURE.md`** — the *what*: the product vocabulary (surfaces/blocks, modes, registers/dials, the fabric).
- **`IMPLEMENTATION.md`** — the *when*: phases 0–7, exit criteria, current status.
- **`CODE_MAP.md`** — the *where*: the tree, dependency rules, and where unbuilt features will land.
- **`CONTRIBUTING.md`** — the *how*: the tier system above.
- **`docs/PHASE*-NOTES.md`** — the decision log: every decision and deviation as each slice landed.
- **`design/renderings/`** — the versioned HTML mockups; the design source of truth for surfaces.

---

## Not here yet (designed, not built — see `IMPLEMENTATION.md`)

- **Workflow substrate** (P4, in flight) — user-composed processing chains as documents; today the
  distill→index→act order is fixed wiring.
- **Screen capture + OCR/VLM** (P4, in flight) — the slots and contracts exist; nothing invokes them yet.
- **Richer routing signals** (staged) — focus landed; calendar next, then topic-drift.
- **Earned canon & pins** (P3) — outbound-use weighting, page-anchored PDF ingestion.
- **Ledger & watchers** (P4) — commitments that auto-close on evidence (a commit hash, a sent thread).
- **Workbench** (P4) — the roomy Vite surface behind the HUD's top-K; currently a scaffold.
- **The editors & gallery** (P6) — surface WYSIWYG, mode canvas, dial editor, custom sandboxed blocks.
- **Drift steering** (P5), **camera / cloud endpoints** (P7).

Everything above already has a home in `CODE_MAP.md`, so no later phase has to invent one.
