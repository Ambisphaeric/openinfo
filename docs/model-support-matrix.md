# Model support matrix

What to run so openinfo's real-time loop actually keeps up, and how the tiers map to the features that
switch on. Model names below are concrete examples of a *class* — any open model of comparable size and
generation is fine. openinfo is vendor-neutral: it talks OpenAI-compatible HTTP to whatever you serve.

## The runtime floor (stated plainly)

openinfo distills a live capture stream: it windows audio/text, calls the `llm` slot on every drain, and
transcribes audio through the `stt` slot before that. To hold the cadence, the serving runtime must offer:

- **Model residency** — the model stays loaded between calls; a runtime that reloads or pages the model
  per request cannot sustain a per-window loop.
- **Concurrent serving** — transcription, distillation, and (at higher tiers) judging overlap; a
  strictly one-request-at-a-time server serializes the pipeline and falls behind.
- **Current throughput optimizations** — continuous batching and speculative-decoding-class features that
  lift prefill + decode throughput.

Serving stacks without these will not sustain the real-time cadence and are not recommended for the loop.
This is a factual capability statement, not a ranking: a runtime is a good fit exactly when it provides
residency, concurrency, and current throughput features.

Per platform:

- **Apple silicon** — an MLX server (e.g. `mlx-lm` / omlx) serving OpenAI-compatible HTTP. Detected and
  adopted automatically; parakeet-class STT runs here too.
- **Windows / Linux (NVIDIA)** — a current CUDA serving stack exposing an OpenAI-compatible endpoint
  (continuous batching + speculative decoding). Point the `llm`/`stt` slots at it like any remote host.

## Speech-to-text (`stt`)

- **Recommended: parakeet-class.** Tiny (~0.5 GB), order-of-milliseconds per chunk on a served runtime —
  it keeps up with the live stream.
- **Fallback: whisper.** whisper.cpp `base.en` / `small.en` is the CPU tier-zero path (bundled in the
  starter catalog). **whisper-large** is accurate but markedly slower — a fallback only, not a real-time
  path. Use it only when parakeet-class serving is unavailable.

## Fast LLM tier (`llm`)

- **Recommended: a current-generation ~8B / 8B-A1B-class model** (high prefill + decode; MoE-style small
  models qualify). This is the fast slot the drain calls every window.
- Older-generation small models (previous-generation ~1.5–3B instruct) are demoted to the tier-zero
  warm-up: fine for a first moment on CPU with no server, not for the sustained loop.

## Tier ladder

Each feature flag carries a `minTier` (see `shared/contracts/examples/flag.examples.json`); a feature is
honest about the fabric it needs, so the ladder below is what actually switches capabilities on.

| Tier | `minTier` | Machine (rough) | Fabric | What it lights up |
|---|---|---|---|---|
| **Tier zero** | `T0` | any | A starter model openinfo downloads and runs on CPU (llama.cpp chat + whisper.cpp STT) — no server | A first captured moment; presence/away signals. A warm-up, not the loop. |
| **BASIC** | `T1` | ~16 GB | parakeet-class STT (~0.5 GB) + a ~12B-class fast chat model (~6 GB) on a residency/concurrency serving runtime | The core loop: distill, typed-moment extraction, entity index, transcription, the follow-up draft, context routing. |
| **JUDGE** | `T2` | BASIC + one more endpoint | Any additional OpenAI-compatible endpoint serving a **27B / 35B-A3B-class** model (local on a second host, or remote) | The judging feature layer — register/voice-drift comparison and escalation that grade and correct the fast tier's output. |
| **Beyond** | `T3` | more headroom / more hosts | Larger or additional slots (dedicated VLM/OCR box, bigger judge) | Reserved for heavier capabilities as they land. |

The `minTier` on a flag is a floor, not a switch: openinfo never blocks you from turning a feature on, but
the tier tells you the fabric that feature honestly needs to do its job. The **Features** section in
`/settings` shows each flag's tier chip against this ladder.

## Notes

- Sizes are approximate and hardware-dependent; the coming capability-benchmarking system measures real
  tok/s on *your* machine (Settings → Diagnostics → Benchmarks).
- Once the real-scenario benchmark (companion issue) lands, these recommendations will cite its measured
  numbers instead of size heuristics.
