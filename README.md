<div align="center">
  <h1>openinfo</h1>

  [![Platform][platform-badge]][platform-url]
  [![Status][status-badge]][status-url]
  [![License][license-badge]][license-url]

  [platform-badge]: https://img.shields.io/badge/platform-macOS%20%C2%B7%20arm64-black?style=flat-square
  [platform-url]: #installation
  [status-badge]: https://img.shields.io/badge/status-pre--release%200.0.5-blue?style=flat-square
  [status-url]: #architecture
  [license-badge]: https://img.shields.io/badge/license-MIT-green?style=flat-square
  [license-url]: LICENSE

  **[Architecture](ARCHITECTURE.md)** | **[Code map](CODE_MAP.md)** | **[Contributing](CONTRIBUTING.md)**

</div>

---

openinfo is a **local-first workflow engine with a thin client**. It captures what you see and hear
(screen, mic, and related signals), runs it through model-driven passes, and writes each result as a
document you can read, diff, edit, and share. The pipeline is **capture → distill → moments / entities
→ surfaces**, and every stage emits a typed document with a one-line *why* back to its source.

It runs local-first: small models (3–30B, offline if you want) process the stream, and modest raw
quality is acceptable because every output is transparent, versioned, and editable. Everything
user-configurable — surfaces, prompts, voice registers, feature flags — is a **versioned JSON
document**, validated against a schema the engine serves, so even an offline local model can write a
valid customization. The meeting HUD you can render today is one configuration the substrate can
express, not the product itself.

Two structural rules hold the whole thing together:

- **The client never touches a database.** Every pixel it shows came through the typed HTTP/WS API,
  which is what makes the backend a config option and workspace isolation structural.
- **Only `engine/store` opens a database handle**, and it is **one SQLite file per workspace**.
  Delete, export, or encrypt a workspace by handling a single file — isolation is not a `WHERE` clause.

## Installation

No release binaries exist yet — build from source. Requires Node 22+ and pnpm 9 (macOS, arm64).

```bash
pnpm install
pnpm -r build                  # contracts → engine + client
pnpm -r test                   # contracts + engine + client suites

# engine daemon — authenticated loopback :8787 by default, data under ~/.openinfo/data
node apps/engine/dist/main.js  # OPENINFO_PORT / OPENINFO_DATA override the port and data dir
```

The control API is local-first, not an unauthenticated LAN service. In default `local` mode the engine
binds loopback only, generates a new 256-bit credential per launch, then atomically publishes
`~/.openinfo/run/engine-<port>.json` (directory `0700`, file `0600`) after the port is listening. The
Electron app reads that record; the credential is never copied into `client.json`, renderer state, or a
URL. `GET /health` is the only public route. Every other read and `/events` requires the Bearer/session
credential, and every `POST`/`PUT`/`DELETE` requires `Content-Type: application/json`, even when bodyless.

For cross-machine use, terminate a trusted TLS tunnel at the engine's loopback listener. Direct plaintext
LAN/public binds are refused:

```bash
umask 077
openssl rand -hex 32 > ~/.openinfo/control-token
OPENINFO_CONTROL_MODE=tunnel \
OPENINFO_PUBLIC_ORIGIN=https://openinfo.example.test \
OPENINFO_CONTROL_TOKEN_FILE="$HOME/.openinfo/control-token" \
node apps/engine/dist/main.js
```

The token file must contain at least 32 URL-safe characters. The tunnel must forward the exact HTTPS
origin to the loopback listener; `OPENINFO_ALLOWED_ORIGINS` can admit additional exact browser origins but
does not bypass auth. Do not expose port 8787 directly to another machine. A tunnel client must receive the
same credential through `OPENINFO_CONTROL_TOKEN` or an owner-only `OPENINFO_CONTROL_TOKEN_FILE`; it does not
use the loopback discovery filename derived from the public HTTPS port. Keychain-backed setup UI is still
future work, so never bridge that UX gap with a token in `client.json`, renderer state, logs, or a URL.

For a packaged macOS app, `pnpm --filter @openinfo/client package` builds an ad-hoc-signed `.app`
bundle, and `pnpm --filter @openinfo/client dmg` wraps it into an arm64 `.dmg` (see
[Getting Started](#getting-started)). There is no signed installer or auto-update yet.

## Getting Started

**1. Bring up the engine and hit the API.** The client never touches a database — everything is the
typed HTTP surface, so `curl` is a first-class way in:

```bash
curl localhost:8787/health # the sole public route: liveness + engine version

# Local development: read the owner-only per-launch record without printing its token.
ENGINE_RECORD="$HOME/.openinfo/run/engine-8787.json"
ENGINE_TOKEN="$(node -e "const r=require(process.argv[1]);process.stdout.write(r.token)" "$ENGINE_RECORD")"
AUTH=(-H "Authorization: Bearer ${ENGINE_TOKEN}")
curl "${AUTH[@]}" localhost:8787/flags
curl "${AUTH[@]}" localhost:8787/layouts/surfaces
curl "${AUTH[@]}" localhost:8787/layouts/surfaces/surf-openinfo-hud
```

Reload the record after an engine restart because the local token rotates. Keep it in the current shell,
never paste it into a URL or log, and `unset ENGINE_TOKEN AUTH` when finished.

**2. Author a surface.** A surface is a document. Its `stack` is a list of blocks, each a
`query + renderer` the engine hydrates from the store and the client paints. This is the whole Glass
Minimal template — two blocks — and what it becomes when the HUD renders it against a live session:

<table>
<tr>
<th>Surface document — what you write</th>
<th>HUD / API — what you get</th>
</tr>
<tr>
<td>

```jsonc
{
  "id": "surf-glass-minimal",
  "name": "Glass Minimal",
  "context": "any",
  "version": 1,
  "stack": [
    { "block": "now" },
    {
      "block": "moments",
      "collapsed": true,
      "query": {
        "source": "moments",
        "params": { "session": "current" },
        "top": 5
      }
    }
  ]
}
```

</td>
<td>

```text
┌───────────────────────────────┐
│ Now · pricing sync            │   ← now block
│ Q3 tiers, discount policy      │
├───────────────────────────────┤
│ Moments (5)                ▸   │   ← moments block
│  ◈ decision  ship on Thursday  │      (collapsed, top 5)
│  ✓ commitment  send the deck   │      typed glyph + text
│  ? question  who owns pricing? │      + a one-line why
└───────────────────────────────┘
```

`GET /layouts/surfaces/surf-glass-minimal` returns the
stored document. `POST /query` with a block's `query`
returns `{ items: [...] }` — the moments the client
renders. Splice a block into `stack`, `PUT` it back, and
the engine revalidates and bumps the version (it keeps
every prior one). Sharing your setup is sending a file.

</td>
</tr>
</table>

Surfaces are the Tier-A surface of a broader tiered model — documents any capable model can safely
write (a failed JSON-Schema validation cannot ship), code-by-recipe, and reviewed core. See
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the full tier table.

**3. Render the HUD.** Three ways to paint the same surface against the same transport:

```bash
# Menu-bar app (dev run): frameless, always-on-top, content-protected window (invisible to screen share)
pnpm --filter @openinfo/client start   # builds, then launches electron .
# ⌘\ or the tray icon → Show HUD reveals it; the tray toggles the session and shows ● rec while capturing.
# OPENINFO_MIC=0 / OPENINFO_SYSTEM_AUDIO=0 disable those capture streams (both ON while a session is live).

# Packaged app: a real .app so macOS attributes mic / Local Network prompts to the app, not the terminal
pnpm --filter @openinfo/client package
open apps/client/release/openinfo-darwin-arm64/openinfo.app
# For the supported local path it reads its URL from config/env/defaults, then loads the matching
# owner-only per-port discovery credential in Electron main.

# Plain browser: serves/paints the HUD assets, but has no engine credential by default
pnpm --filter @openinfo/client build
npx serve apps/client   # http://localhost:3000/dev-hud.html?engine=http://127.0.0.1:8787
```

Production Electron injects authentication only for trusted built-in windows and the exact engine origin;
renderer JavaScript never receives the Bearer. A standalone browser cannot read the private discovery file
or inject a WS Authorization header, so the command above does not connect directly to the hardened engine
without an explicit authenticated browser-session bootstrap and exact allowed Origin. Never work around
that limitation by putting the token in the query string.

Against a bare engine the HUD renders the honest empty state — a Now line and an empty block stack —
not a broken one, since the data a block shows is gated upstream.

**4. See the pipeline run.** Flip the relevant flags (they are documents; changes take effect without a
restart), then drive capture:

```bash
for f in distill.enabled distill.moments distill.index act.enabled; do
  curl -sX PUT localhost:8787/flags/$f "${AUTH[@]}" -H 'content-type: application/json' \
    -d "{\"key\":\"$f\",\"default\":true,\"scope\":\"engine\",\"description\":\"on\"}"; done
```

`/settings` has a **Try it** section — type or speak a sentence and watch openinfo turn it into a typed
moment live (glyph, text, and the `via <endpoint> · <model>` provenance). Or POST a text `CaptureChunk`
to `/capture/mic` and the drain distills it into moments/entities the HUD surfaces. Without an endpoint,
capture is still accepted and durably spooled (retried at idle — nothing is lost).

## Configure models

The distill pass needs an OpenAI-compatible LLM endpoint (Ollama, LM Studio, mlx); the `llm` slot ships
empty. Open `/settings` — its **Get started** section probes well-known local servers, reads what each
has loaded (`GET /v1/models`), classifies models by name, and offers one button to write and activate a
`config-1` profile. If nothing is found it offers a small vetted starter model, or prints the exact
`brew install` line when a runtime is missing.

**What to run.** For the real-time loop, serve a current-generation ~8B-class chat model for the fast
`llm` slot and a parakeet-class model for `stt` (order-of-milliseconds per chunk; whisper is a slower
CPU fallback). The starter-model downloads are a tier-zero warm-up — enough for a first moment on CPU,
not the sustained cadence. The loop needs a serving runtime with model residency, concurrency, and
current throughput optimizations (speculative-decoding-class features): **mlx/omlx** on Apple silicon,
a current **CUDA** equivalent on Windows/Linux. Runtimes without those will not keep up. Adding a
27B / 35B-A3B-class model on any OpenAI-compatible endpoint lights up the judging layer. The full
BASIC → JUDGE tier ladder — tied to the feature flags' `minTier` gates — is in
[docs/model-support-matrix.md](docs/model-support-matrix.md).

```bash
# Use the app's tray/gear → Settings. It exchanges a one-use ~30s ticket, then opens a clean URL.
curl "${AUTH[@]}" localhost:8787/fabric/discover # same detection as JSON
```

Your **fabric** is a saveable, switchable document: `GET`/`PUT /fabric` is the active profile — a named,
cloneable slot→endpoint map. Remote endpoints reference a key **by name, never a value** — the value is
stored once (write-only, in a chmod-600 file) and injected as `Authorization: Bearer …` only at invoke
time. Endpoints, profiles, keys, and per-endpoint testing are all driven by the authenticated `/settings`
page, so you rarely need raw curls. Opening `/settings` without the app's one-use ticket renders only a
locked shell; consuming the ticket creates an in-memory `HttpOnly; SameSite=Strict` cookie (`Secure` in
tunnel mode) and redirects away from the credential-bearing URL.

## Architecture

The client and engine meet at exactly one seam — `shared/contracts` — and nothing crosses it untyped.
The engine is the only process that opens a database, and it opens one SQLite file per workspace, so
isolation is a file boundary rather than a query predicate. Everything user-facing (surfaces, prompts,
registers, flags, the pipeline itself) is a versioned document the engine validates on write.

```
CLIENT (thin)  ──HTTP + WS──▶  ENGINE (daemon)          loopback-only listener;
Electron                      api · distill · index      HTTPS tunnel (explicit env/token-file credential)
never opens a DB              voice · surfaces · store · queue · fabric
        ╲                                    │
         ╲── shared/contracts ──────────────╱   the ONLY seam; nothing crosses it untyped
```

The table below is the high-level status of the system as it stands today. Every area listed as working
is exercised by the test suites and, for the served surfaces, driven end-to-end.

| Area | What it is | Status |
|---|---|---|
| **Capture** | Mic + system-audio streams (BlackHole detect-and-guide); screen frames behind an opt-in flag | Working |
| **Distill pipeline** | Rolling-merge summaries, typed moments (commitment / question / decision / artifact), a recency×frequency entity index | Working |
| **Sessions & routing** | Manual session lifecycle; focus + calendar signals auto-attribute a session to a workspace; one-click retroactive reroute | Working |
| **Surfaces & HUD** | Surfaces-as-documents, a generic block renderer, a content-sized HUD window that opens hidden | Working |
| **Workflow substrate** | Executor + drain stages, hot-editable over `GET`/`PUT /workflows` | Working — flag-gated (`workflow.enabled`, off by default) |
| **Fabric** | Profiles / secrets / discovery, engine-managed local runtimes (incl. mlx/omlx), STT adapters (openai · omlx · whisper-server) | Working |
| **Canon · teach · pins** | Reference-merging canon, the reroute→hint teach loop, page-anchored pin ingestion; pins render live in the `pinned-doc` block, teach candidates in the `teach` block (accept wired to the hints document) | Working |
| **Settings** | Engine-served `/settings` page: status, endpoints, profiles, keys, local runtimes, features, HUD layout, try-it | Working |
| **DMG packaging** | arm64, ad-hoc signed; the shell adopts a running engine or spawns the bundled one on first launch | Working — dev/ad-hoc (no notarization or auto-update) |

## HTTP surface

Everything is the typed API. `GET /health` alone is public; every route below requires Bearer or an
authenticated browser session. `GET /routes` lists the shared application-route manifest and
`GET /contracts` lists its schemas; the short-lived `/auth/browser-ticket` → `/auth/browser` bootstrap is
an engine-internal control-plane exception, not application data. A representative slice:

| Route | What it returns / does |
|---|---|
| `GET /health` | Engine liveness + version. |
| `GET /flags` · `PUT /flags/:key` | Every feature flag (all `default:false`); flip one (hot, no restart). |
| `GET /layouts/surfaces[/:id]` · `PUT /layouts/surfaces/:id` | List / read a surface document; write one back (revalidated, version-bumped). |
| `POST /query` | Hydrate a block's query against the store — the exact call the client makes. |
| `GET /moments` · `/entities` · `/relevant` | The distilled records: typed moments, the entity index, the relevant-now join. |
| `GET /sessions` · `POST /sessions` | Session list / lifecycle. |
| `GET`/`PUT /workflows` | The pipeline as an editable, version-stamped document. |
| `GET`/`PUT /fabric` · `GET /fabric/discover` · `POST /fabric/scan` · `POST /fabric/test` | Active model profile; probe / scan / test model endpoints. |
| `GET /queue` | Backlog depth by kind, an honest ETA, and the last classified failure. |
| `GET`/`POST /pins` · `POST /pins/:id/ingest` · `GET /pins/:id/chunks` | Canon pin ingestion and the page-anchored "cite p.42" excerpts. |
| `GET /hints` · `GET`/`PUT /hints/:workspaceId` · `GET /teach/candidates` | The attribution teach loop — suggested hint candidates, applied by editing a document. |
| `GET /settings` | The engine-served settings page (`/setup` 301s here). |

The engine's internal bus retains the full `CaptureChunk` for local processors. The public
`capture.received` WS payload is a metadata-only `CaptureReceipt`—no raw `data`, preview, derived text, or
hash crosses the socket. That API boundary is separate from model-fabric egress: OCR/VLM raw frames remain
loopback-only unless a specific private-LAN HTTP endpoint explicitly sets `trustRawFrames: true`; the opt-in
never permits a public destination and never grants access to engine routes.

## Packages

| Package | Role |
|---|---|
| `shared/contracts` | The only shared dependency — the typed seam: records, config documents, HTTP routes + WS events, the block query DSL, and the generated (language-neutral) JSON Schema. |
| `apps/engine` | The daemon: `api` (one dispatcher) · `store` (SQLite-file-per-workspace) · `distill` · `index` · `route` · `fabric` · `workflow` · `surfaces` (incl. the served `/settings`) · `queue`. |
| `apps/client` | The thin Electron/browser client: `capture` · `engine-link` (typed client + offline spool) · the pure block renderer · the HUD shell. Never opens a database. |
| `apps/workbench` | A Vite app served by the engine (roomy surface behind the HUD) — scaffold. |
| `templates/` | The gallery — documents only, no code (the openness proof). |
| `skills/` | Shipped customization recipes a local model can follow (Tier A). |
| `design/renderings/` | Versioned HTML mockups — the design source of truth for surfaces. |
| `tools/` | Schema-gen · bench harness · fixtures (capture record/replay) · per-tier evals. |

## What's next

The areas below are designed and tracked but not yet shipped. Each maps to a public milestone on the
[issue tracker](https://github.com/Ambisphaeric/openinfo/milestones) (Ambisphaeric/openinfo); the
milestone names are the section headings.

### M1 — Blocks render the pipeline ✓ (shipped)

The block set now renders the pipeline's primitives end to end. Five block types joined `now` /
`moments` / `relevant-now` / `pinned-doc`: **todos** (✓/○ status, "from the meeting" vs "added by
you"), **drafts** (the prepared follow-up, with its distillate/moment lineage), **teach** (suggested
attribution hints with support counts), **distillates** (the rolling summary stream), and **queue**
(honest backlog, basis-aware ETA, and the last classified failure as visible text). Why-lines render
the **recorded provenance** (`via <endpoint> · <model> · <time>`) instead of hand-rolled strings, and
a row that cannot state its one-line why is dropped rather than decorated. Action verbs write for
real with visible outcomes — `copy` (clipboard + fallback, "Copied"/"Copy failed"), `mark-done`
(flips the to-do over `PUT /todos`), `accept` (appends a teach candidate to the hints document);
verbs with no honest write path yet (`dismiss`, `open`, `run-mode`, `draft-with`) render inert
rather than pretend.

### M2 — Panel designer

A surface WYSIWYG: surface lifecycle (new / rename / duplicate / delete), a query builder in the block
row, and a driven e2e for the editor script.

*Placeholder — lands with M2.*
<!-- placeholder: filled in when the panel designer ships -->

### M3 — Multi-panel shell

A multi-window shell keyed by surface id, per-surface window options with position persistence, and an
open-as-panel affordance.

*Placeholder — lands with M3.*
<!-- placeholder: filled in when the multi-panel shell ships -->

### M4 — Pipeline durability

Hardening the capture→drain path: an un-wedgeable capture controller with a renderer-readiness
handshake, and soak tests asserting sustained capture/drain survives injected failure with no duplicate
records.

*Placeholder — lands with M4.*
<!-- placeholder: filled in when pipeline durability ships -->

### M5 — Prompt & skill layer

The prompt engine proper: `GET`/`PUT` routes for prompt templates, registers, and modes; a settings
surface to edit them; the workflow executor honoring per-step template/slot/params; the six planned
skills (only `add-a-block` exists today); and the empty surface templates filled and seeded.

*Placeholder — lands with M5.*
<!-- placeholder: filled in when the prompt & skill layer ships -->

### M6 — QA & launch readiness

The `tools/fixtures` record/replay harness, an Electron e2e gate, a HUD block-renderer mount+actions
test, driven tests for the browser scripts, and a packaged capture-to-panel smoke per release.

*Placeholder — lands with M6.*
<!-- placeholder: filled in when QA & launch readiness ships -->

### M7 — Packaging & docs

Stable signing + notarization (stop the per-rebuild permission re-prompts), auto-update, and a
self-hoster install doc.

*Placeholder — lands with M7.*
<!-- placeholder: filled in when packaging & notarization ship -->

### M8 — Open frontend tooling / SDK

Extracting the typed client + block renderer into a standalone package, publishing the HTTP/WS contract
and the surface-document + block spec as versioned specs for external renderers.

*Placeholder — lands with M8.*
<!-- placeholder: filled in when the open frontend tooling / SDK ships -->

### Windows / WSL and Linux backends

Build compatibility beyond macOS — **to be explored** (issues #1 and #2).

*Placeholder — lands when the non-macOS backends are explored.*
<!-- placeholder: filled in when Windows-WSL / Linux backends land -->

## Where the docs live

- **`ARCHITECTURE.md`** — the *what*: the product vocabulary (surfaces/blocks, modes, registers/dials, the fabric).
- **`IMPLEMENTATION.md`** — the *when*: phases 0–7, exit criteria, current status.
- **`CODE_MAP.md`** — the *where*: the tree, dependency rules, and where unbuilt features will land.
- **`CONTRIBUTING.md`** — the *how*: the tier system and the code-by-recipe path.
- **`docs/PHASE*-NOTES.md`** — the decision log: every decision and deviation as each slice landed.
- **`design/renderings/`** — the versioned HTML mockups; the design source of truth for surfaces.

## Contributing

Contributions are welcome. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) for the tier system (documents →
code-by-recipe → reviewed core) and the recipes a local model can follow to customize safely, and
[`CODE_MAP.md`](CODE_MAP.md) for where any new feature is expected to land. openinfo is a strangler fork
that absorbs prior art (glass and others) — see `ARCHITECTURE.md` for what was salvaged and why.

## License

<sup>
Licensed under the <a href="LICENSE">MIT License</a>.
</sup>
