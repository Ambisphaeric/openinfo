# Design critique — openinfo at a 100-person organization

**Purpose:** stress the plan against "maximally useful for pretty much everybody," not just its author.
Each critique lands as a concrete amendment; amendments are folded into ARCHITECTURE/IMPLEMENTATION as they're
accepted. · 2026-07-07

---

## 1. Hardware diversity is the org's defining fact → the capability ladder becomes a contract

A hundred people means MacBook Airs, gaming rigs, one person with a 3090 server, and a few who'll point at a
hosted endpoint. The plan already has the fabric and the envelope check; what it lacks is a **published tier
contract** so features degrade predictably instead of anecdotally:

| Tier | Example models (local) | What must work |
|---|---|---|
| **T0** | qwen3-4b, qwen3-30b-a3b @ low ctx, phi-4-mini | distill merge, moments, follow-up draft — the core loop. Everything here is deliberately **high-compression / low-token**: ≤700 tok/pass budgets, tight schemas |
| **T1** | qwen3-8b, llama-3.2-8b | + entity extraction at usable precision, relevant-now, register interpolation with visible effect |
| **T2** | qwen3-30b-a3b full, 14–32B dense | + register *detection* (drift), canon merging, markedly higher cross-workspace recall quality — breadth of clarity is a tier property, not a promise |
| **T3** | hosted/frontier (optional, flagged) | + long-horizon synthesis, org-pack authoring assistance |

**Amendments:** (a) every feature declares its minimum tier in its flag document; (b) prompt templates carry a
`tokenBudget` ceiling as data; (c) `tools/evals` becomes Phase-0-adjacent, not Phase-7 polish — golden fixtures
(recorded via `tools/fixtures`) scored per tier on **mlx** locally: extraction F1, register-detection error,
compression fidelity, tok/pass. The eval harness *is* the benchmark of the workflow engine's utility.

## 2. A hundred users are not one persona → templates and taste must cover non-engineers

The five shipped templates skew maker/meeting. Sales, support, exec, and PM users need the gallery to prove
breadth: the plan's openness only helps people who can imagine a configuration.
**Amendments:** (a) at least one shipped template is non-engineering (e.g. `sales-floor`: pre-call brief +
CRM-ish pinned canon + high-charm register); (b) **taste packs** — a shareable folder of documents
(`registers/ + surfaces/ + modes/ + flags.yaml`) importable in one action. Taste can't be architected centrally, but
users can share it → users *share* taste as config; the org curates a gallery of packs the way it curates dotfiles.

## 3. Org knowledge vs personal capture → the pack is the sharing unit, never the database

The SOC 2 belongs to the org; the meeting where you joked about it belongs to you. The DB-per-workspace design
is right and must stay personal — multi-tenant engines are explicitly out of scope.
**Amendments:** (a) **org packs**: shared pins (canon docs with page anchors), registers, templates, flags —
distributed as files (git repo, shared drive), imported per user; capture data never leaves the user's engine;
(b) consent is a first-class surface at org scale: visible recording state, per-mode "no-capture rooms"
(calendar-matched), retention defaults in the workspace document. Trust is a feature with a UI, not a policy PDF.

## 4. Community/local-LLM contributions → standards must be mechanical, not aspirational

The goal: a local model (qwen3-30b-a3b, even 8B on tight rails) can make a real contribution. That works only
where the change surface is a **recipe** — a bounded, schema-validated, pattern-matched diff:

- **Tier A (documents, any capable model):** new register, new template, new block instance, new flag,
  taste pack. Schema-validated; a wrong document cannot ship. Shipped `skills/` walk models through these.
- **Tier B (code-by-recipe, 30B-class):** new built-in block type, new watcher, new fabric runtime. Each has a
  CONTRIBUTING recipe: files to create (one concern per file), the interface to implement from contracts, the
  test to copy-adapt, the flag to add. Small files, strict tsconfig, no cleverness.
- **Tier C (core, humans + frontier models):** store, router, seam, contracts changes. Guarded by CODEOWNERS.

**Amendments:** CONTRIBUTING.md encodes the recipes (written); CI gates = types + schema validation + evals
regression; repo style rules chosen for machine-writability (one concern per file, no barrel magic, explicit
imports, conventional commits).

## 5. OCR/vision as a first-class fork → PaddleOCR in the fabric, parallel loading as a requirement

Screenshot understanding is either an `ocr` slot (PaddleOCR — fast, parallel-load-friendly, CPU-viable) or a
`vlm` slot (richer, heavier). Users pick per mode; the queue processes deferred images and **deletes raw after
distillation** either way.
**Amendments:** (a) `runtime: "paddle"` is a supported local endpoint runtime alongside `mlx`, `ollama`,
`llama.cpp`, `whisper.cpp`; (b) the engine's slot loader must support **concurrent residency** (paddle + stt +
tts + llm resident together) under a configurable memory budget — this is a fabric requirement, recorded in the
contract, not an optimization.

## 6. What we're explicitly NOT doing at org scale

- No multi-tenant engine, no central capture store, no admin who can read anyone's distillates.
- No org-wide telemetry: evals run on local fixtures; quality data stays local unless a user exports a fixture.
- No blessing of a single model vendor: tiers are measured (`tools/bench`), never assumed.

## Verdict on feasibility

Feasible, with two honest caveats. (1) T1-tier extraction (8B) will be noisy at first — the teach loop
(dismiss/confirm signals) plus retry-at-idle with a bigger model is the designed compensation, and the eval
harness is how we know it's working rather than hope. (2) Tier-B code contributions from small local models are
viable *only inside recipes* — the moment a change needs judgment across modules, it's Tier C. The architecture
was already shaped for this (documents everywhere, one-concern modules, typed seam); these amendments make it
enforceable rather than intended.
