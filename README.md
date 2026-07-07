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

**Status:** pre-release, mid-Phase-2, moving fast. What works today: capture spools into the engine,
a rolling-merge **distill** pass emits summaries + typed **moments** (● commitment ◆ question-at-you
▲ decision ✱ artifact) + an entity **index** with recency×frequency ranking, manual **sessions**
steer voice, and the **HUD** renders entirely from a surface document through the real block
renderer. Every feature ships behind a flag, **OFF by default**. Router, ledger, pins, and the visual
editors are designed but not built (see `IMPLEMENTATION.md`).

---

## Quickstart

Verified from a clean tree (macOS, Node 22+, pnpm 9). Clone to a rendered HUD:

```bash
pnpm install
pnpm -r build          # contracts → engine + client (workbench is a Phase-4 scaffold)
pnpm -r test           # contracts schema-validation + engine (60) + client (7)

# start the engine daemon — localhost:8787 by default, data under ~/.openinfo/data
node apps/engine/dist/main.js            # OPENINFO_PORT / OPENINFO_DATA to override
```

With the engine up, everything is the typed HTTP API — the client never touches a database:

```bash
curl localhost:8787/health
curl localhost:8787/flags                     # every flag, all default:false
curl localhost:8787/registers                 # the 5 built-in voice registers
curl localhost:8787/layouts/surfaces/surf-openinfo-hud   # the HUD, as a document

# start a session, then ask the HUD's relevant-now block for data
curl -sX POST localhost:8787/sessions -H 'content-type: application/json' \
  -d '{"workspaceId":"demo","modeId":"mode-meeting","title":"first run"}'
curl -sX POST localhost:8787/query -H 'content-type: application/json' \
  -d '{"source":"relevant-now","params":{"workspace":"demo"},"top":4}'
```

**Render the HUD** (Phase 1 left no Electron window yet — a browser dev entry stands in):

```bash
pnpm --filter @openinfo/client build
npx serve apps/client          # or any static server
# open http://localhost:3000/dev-hud.html?engine=http://127.0.0.1:8787
```

The HUD renders against a bare engine — the Now line, the block stack, empty explainable blocks.
That is the honest state, not a broken one: the data a block shows is gated upstream.

**To see distill / moments / index actually run**, two things must be true. First, flip the flags
(they're documents; flip over the API, effective without a restart):

```bash
for f in distill.enabled distill.moments distill.index; do
  curl -sX PUT localhost:8787/flags/$f -H 'content-type: application/json' \
    -d "{\"key\":\"$f\",\"default\":true,\"scope\":\"engine\",\"description\":\"on\"}"; done
```

Second — **the distill pass needs an OpenAI-compatible LLM endpoint** (Ollama, LM Studio, mlx). The
`llm` slot ships empty; point it at your local server:

```bash
curl -sX PUT localhost:8787/fabric -H 'content-type: application/json' -d '{"slots":{
  "stt":[],"tts":[],"vlm":[],"ocr":[],"embed":[],
  "llm":[{"name":"llm.local","kind":"http","url":"http://127.0.0.1:11434",
          "model":"llama3.2:3b","api":"openai-compat"}]}}'
```

Without an endpoint, capture is still accepted and durably spooled; the drain simply re-queues it
(retry-at-idle — nothing is ever lost) and no moments appear. With one, POST a text `CaptureChunk`
to `/capture/mic` and the drain distills it into moments/entities the HUD then surfaces.

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
- **`docs/PHASE1-NOTES.md` / `docs/PHASE2-NOTES.md`** — every decision and deviation as each slice landed.
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

## Not here yet (designed, not built — see `IMPLEMENTATION.md`)

- **Router** (P3) — context-switch detection, workspace attribution, one-click retroactive reroute.
- **Canon & pins** (P3) — reference-merging, page-anchored PDF ingestion, the "p. 42 + copy bar" answer.
- **Ledger & watchers** (P4) — commitments that auto-close on evidence (a commit hash, a sent thread).
- **Workbench** (P4) — the roomy Vite surface behind the HUD's top-K; currently a scaffold.
- **The editors & gallery** (P6) — surface WYSIWYG, mode canvas, dial editor, custom sandboxed blocks.
- **Drift steering** (P5), **camera / cloud endpoints** (P7).

Everything above already has a home in `CODE_MAP.md`, so no later phase has to invent one.
</content>
</invoke>
