# Pipeline fixtures — deterministic record/replay

`tools/fixtures` records normalized capture and model-boundary events once, then replays them without
calling a microphone, screen API, model server, or network endpoint. It is the deterministic substrate
for capture → STT/OCR/VLM → downstream pipeline tests.

The committed example is entirely synthetic but represents the three independent evidence lanes:

- microphone capture → canonical STT output;
- system-audio capture → a separate canonical STT output;
- screen image + companion frame metadata → canonical OCR and VLM outputs.

Convergence never rewrites those lanes. Every stage result names exactly one earlier capture id and
retains its lane. V1 deliberately models one model invocation per capture; batch inputs and duplicate
results for the same `(stage, capture)` are rejected rather than replayed ambiguously.

## Format and integrity

`fixture.schema.json` is the committed JSON Schema generated from `schema.mjs`. The envelope format is
`openinfo.pipeline-fixture`, with its own `formatVersion: 1` independent of app/package versions.
Readers reject unknown format versions before replay. Additive unknown fields at the same version are
ignored so a v1 producer can add optional metadata without breaking an older v1 reader.

The recorder assigns contiguous ordinals and content-derived entry ids. `recordedAt`, `replay.at`, capture
ids, and source timestamps are data — it never consults `Date.now()` or `randomUUID()`. The fixture id is
derived from a SHA-256 digest over canonical JSON of the envelope excluding `fixtureId` and `digest` (both
are derived values). Object keys are code-point sorted; arrays preserve semantic order; the file has one
trailing newline, which is not part of the digest input.

Before replay emits an entry or builds an invoker, the entire fixture is checked for schema, version,
canonical UTC timestamps, contiguous ordinals, unique ids, earlier capture references, lane agreement,
stage/slot agreement, privacy declarations, and digest integrity. A corrupt tail therefore cannot cause
partial callbacks or writes.

## Record

Input is a JSON array or one JSON object per line. Each object is a normalized `capture`, `stt`, `ocr`, or
`vlm` event in runtime order. See `examples/synthetic-converged.jsonl` for the complete shape.

```sh
node tools/fixtures/cli.mjs record \
  --input tools/fixtures/examples/synthetic-converged.jsonl \
  --output tools/fixtures/fixtures/synthetic-converged.v1.json \
  --privacy synthetic \
  --allow-raw-media \
  --replay-at 2026-07-12T13:00:03.000Z
```

Classification is mandatory. Inline audio/image bytes are refused unless `--allow-raw-media` is explicit,
even when the bytes are synthetic. A capture with `media:"redacted"` must have an empty data payload; put
non-reversible hash/size metadata in additive fields if the test needs it. Real bytes use `media:"raw"`,
which requires `--privacy sensitive` and an output under `tools/fixtures/private/` (or a `*.local.json`
file under this tool directory). Those paths are gitignored and files are written mode `0600`; force
replacement re-applies that mode.

Never assume `sanitized` means an automatic PII detector reviewed the text — it is a user assertion.
Screen images, transcripts, window titles, filenames, chat text, tokens, and model replies can all expose
private or secret data. Keep real recordings local, owner-only, and out of git. The CLI never prints event
payloads; summaries contain only ids, counts, digest, and the privacy declaration.

## Validate and replay

```sh
node tools/fixtures/cli.mjs validate \
  --input tools/fixtures/fixtures/synthetic-converged.v1.json

node tools/fixtures/cli.mjs replay \
  --input tools/fixtures/fixtures/synthetic-converged.v1.json
```

Both commands exit nonzero on malformed/corrupt data and emit a payload-free JSON summary. `replay` is a
validation/dry-run CLI; pipeline tests use the pure library boundary:

```js
import { createFixtureReplay, loadFixtureSync } from './model.mjs'

const fixture = loadFixtureSync('tools/fixtures/fixtures/synthetic-converged.v1.json')
const replay = createFixtureReplay(fixture)
const frame = replay.captures('screen').find((chunk) => chunk.contentType.startsWith('image/'))
const result = await replay.invokeOcrFor(frame.id, { image: frame.data, contentType: frame.contentType })
```

Use the capture-scoped invokers (`invokeSttFor`, `invokeOcrFor`, `invokeVlmFor`) in pipeline tests. They
verify request bytes against the named capture and prevent equal bytes in two lanes from crossing source
identity. The unscoped invokers exist for single-input adapters and fail when equal payloads have different
recorded outputs. `replay.now` and `replay.newId` are injectable deterministic clock/id factories; `reset()`
rewinds both, so replaying into idempotent stores yields byte-identical records rather than duplicates.

## Checks

```sh
pnpm --filter @openinfo/fixtures test
pnpm --filter @openinfo/engine build
node --test apps/engine/dist/screen/processor.test.js
```

The real `ScreenOcrProcessor` test consumes the committed fixture, replaces only its model boundary, runs
twice into `WorkspaceRegistry`, and asserts one byte-identical `OcrResult` and `Distillate` remain. The
fixture suite also pins no-network replay, corruption fail-closed behavior, schema drift, source collision,
privacy, safe overwrite, permissions, and deterministic serialization.
