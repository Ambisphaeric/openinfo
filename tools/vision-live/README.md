# Real-frame OCR/VLM validation (#175)

This owner-run gate captures a generated, PII-free full-screen card through the real macOS compositor
and proves both screen owners against explicitly trusted LAN model endpoints:

- `workflow.enabled` off: legacy ingest owns the frame and invokes the `ocr` slot;
- `workflow.enabled` on: a temporary workflow document selects a real `vlm` drain step.

The harness launches a temporary authenticated engine and store. It does not edit the installed app,
the live fabric, the owner's workspace databases, or the model server configuration. The test card is
the only screen content visible while capture runs. JPEG bytes are sent only to the LAN endpoint after
the explicit `trustRawFrames` opt-in. The production queue/offline-spool safety paths may write them
transiently inside the harness's private temporary tree; that whole tree is recursively removed before
PASS, so no frame is retained in the repository, owner database, or report. The report defaults to the
owner-only, gitignored `tools/fixtures/private/` directory with mode `0600`; it contains derived synthetic
model text and provenance for audit, but never pixels, image base64, endpoint URLs, or credentials.

## Preconditions

1. Build on macOS with Screen Recording already granted to the Electron/openinfo executable used for
   the run. If macOS returns no frame, the harness fails honestly and tells you to grant access and
   relaunch; it never changes System Settings itself.
2. Choose an OpenAI-compatible LAN server that advertises both selected vision models at
   `GET /api/v1/models`. The OCR slot may use a dedicated OCR vision model; the VLM slot must advertise
   `capabilities.vision: true`.
3. Choose a Gemma-12B-class model for the concurrent synthetic workload. No real screen-derived text is
   sent to that workload; Ask is proven through a loopback fake model so the standing derived-text egress
   sign-off is not silently expanded.

## Run

Endpoint URLs and credentials are deliberately arguments/environment, never committed defaults. The
explicit trust flag is mandatory:

```sh
OPENINFO_VISION_URL='http://LAN-HOST:PORT' \
OPENINFO_OCR_MODEL='YOUR-OCR-MODEL' \
OPENINFO_VLM_MODEL='YOUR-VISION-MODEL' \
OPENINFO_GEMMA_MODEL='YOUR-GEMMA-12B-MODEL' \
pnpm vision:live -- --trust-lan-raw-frames
```

Optional controls:

```text
--vision-key-env ENV_NAME   bearer key for model inventory + OCR/VLM
--gemma-url URL             separate LAN workload server (defaults to vision URL)
--gemma-key-env ENV_NAME    bearer key for the Gemma workload
--engine-node PATH          Node runtime that can load the installed better-sqlite3 binary
--samples N                 changed frames per owner/mode (default 2, max 10)
--cadence-ms N              3000..6000; default 5000 (the product still-frame cadence)
--timeout-ms N              per-result timeout, default 120000
--output PATH               private JSON report path
```

`OPENINFO_ENGINE_NODE` is the environment equivalent of `--engine-node`; the harness otherwise probes
common local Node 25 locations and fails closed if none can load the installed native SQLite module.

The script requires a real private-LAN vision host for the #196 boundary proof; loopback would prove only
device-local processing and is refused for this recipe. Public, malformed, and wildcard vision hosts remain
refused even when the trust flag is present. The report records only the safe destination class and the
public/wildcard negative truth-table results, never the endpoint URL.

## What passes

- real desktop pixels → production delta gate → production capture controller/link → authenticated
  `/capture/screen` → queue;
- legacy OCR and workflow VLM each produce exactly one `OcrResult` and one mirror `Distillate` per kept
  frame, with exact source-chunk attribution plus slot/endpoint/model/usage provenance;
- both persisted records carry byte-identical `destination:'lan-local'`, `rawFrameTrust:'explicit'`
  provenance whose safe reason says raw bytes crossed the device boundary; no URL or credential is retained;
- `/screen/results`, `/screen/status`, `/senses/live`, and the `distillates` surface query agree;
- an unchanged real frame is `delta-skipped` and produces no result;
- actual capture-attempt intervals remain in the 3–6 second band (with a documented 250 ms scheduler
  tolerance) and are summarized separately from model-result latency;
- Ask receives the ambient persisted distillate without a per-send screenshot or raw image;
- a concurrent synthetic Gemma-class completion runs while each screen mode is exercised;
- the report records invoke/wall/end-to-end latency, both queue-track peaks, local Electron/engine memory,
  and server-advertised model sizes/loaded instances. Model size is explicitly labeled as a pressure proxy,
  not remote-host RSS; capture remote RSS separately when the rig exposes an owner-approved telemetry seam.

## Failure-state and privacy proof map

The live gate is paired with deterministic executable coverage:

- missing flag/endpoint and visible gate order: `surfaces/settings/sense-gates.test.ts`;
- blank frame, processor failure state, and bounded `/screen/status` ring: `screen/processor.test.ts`;
- invalid response, timeout, model failure, LAN trust, public/wildcard refusal: `fabric/ocr.test.ts`,
  `fabric/vlm.test.ts`, and `fabric/egress.test.ts`;
- raw bytes absent from logs/status even when a server echoes the request: the echoed-sentinel OCR/VLM
  and processor regressions;
- raw bytes absent from generic WebSocket events: `api/http-security.test.ts` and `api/ws.test.ts`;
- deterministic dual-owner/dual-slot persistence, surface, and Ask: `screen/acceptance-175-e2e.test.ts`.

Never attach the private JSON report, captured screens, endpoint URL, control discovery record, or keys to
a public issue. Post only the derived pass/fail summary, endpoint/model names, counters, and aggregate
latency/memory numbers after reviewing them for local identifiers.
