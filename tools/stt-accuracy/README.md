# stt-accuracy — transcription-accuracy harness (#97, seeds #95)

Renders known utterances with `say` (synthesized voice, rendered to **file** — it never plays audio),
then transcribes each one (a) whole-file and (b) through each candidate **chunking strategy** against a
local STT endpoint, and prints a word-accuracy (WER) table against the reference text. Silence and
pink-noise probes confirm the model isn't hallucinating (they must come back empty).

**Why it exists:** the 1s-chunk corruption (#95) shipped with green suites because nothing measured
transcript ACCURACY end-to-end — only that plumbing moved bytes. The whole-vs-chunked WER delta is the
regression metric for the architecture fix.

## Requirements
- macOS `say` and `ffmpeg`/`ffprobe` on PATH.
- A reachable local STT endpoint (OpenAI-compatible `/v1/audio/transcriptions`, accepts wav).

## Usage
```sh
# parakeet (no auth)
node tools/stt-accuracy/measure.mjs \
  --endpoint http://localhost:8002/v1/audio/transcriptions \
  --model mlx-community/parakeet-tdt_ctc-110m

# whisper via an omlx-style host that needs a bearer key (pass the key by ENV name, never inline)
STT_API_KEY="$MY_KEY" node tools/stt-accuracy/measure.mjs \
  --endpoint http://localhost:8000/v1/audio/transcriptions \
  --model mlx-community--whisper-large-v3-turbo-asr-fp16
```

Flags (all optional): `--model`, `--strategies whole,fixed,overlap,vad`, `--cadences 1,2,5`,
`--overlap-window 5 --overlap-hop 2`, `--rate 175` (say wpm), `--json`, `--keep` (leave rendered wavs).
Env fallbacks: `STT_ENDPOINT`, `STT_MODEL`, `STT_API_KEY` (or `--api-key-env NAME`). **No endpoint is
hardcoded to any machine** — pass them; localhost is only the default.

## Strategies
- `whole` — the whole file in one request (the accuracy ceiling / reference).
- `fixed` — non-overlapping N-second segments transcribed independently (reproduces the 0.0.8 slicing).
- `overlap` — rolling W-second windows every H seconds, reconciled by a word-level overlap merge
  (`mergeOverlap`, exported for the engine test). Measured **worse** than doing nothing on continuous
  speech — the boundary span transcribes differently in adjacent windows so exact-overlap dedup fails and
  duplicates it. Kept as a measurable candidate, not shipped.
- `vad` — cut at ffmpeg-detected silences (no cut lands mid-word). The shipped winner.

## Manual gate (CI-less)
Run before a release when the transcription path or a default changed; paste the table into the PR /
release checklist (the "transcript accuracy" row, #31 territory). A fixed-1s mean WER well above whole-file
is the regression this catches.
