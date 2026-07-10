import type { StarterModels } from '@openinfo/contracts'

/**
 * Seeded starter models (ARCHITECTURE §8 tier zero, slice c). A DOCUMENT (everything user-configurable
 * is a document): seeded only when absent, versioned in _meta.db, editable via the store. Mirrors the
 * validated example in shared/contracts/examples/starterModels.default.json.
 *
 * Choices (2026-07, honest current defaults): llm → llama.cpp GGUF chat models from bartowski
 * (Qwen3 1.7B/4B — Apache-2.0, ungated, no HF login); the 1.7B is the first-run default because it
 * warms fast (the cold-large-model gotcha the discovery slice recorded). stt → whisper.cpp ggml models
 * from ggerganov/whisper.cpp (base.en / small.en). Sizes are approximate — stated honestly in the UI;
 * the real integrity check at download time is the server Content-Length + a truncation floor.
 *
 * TIER ZERO, not the recommended setup. This catalog exists so a user with NO model server still reaches
 * a first moment on CPU/GGUF. It is deliberately small and CPU-friendly — it is not the fast tier that
 * sustains the real-time loop. That tier is a current-generation ~8B-class chat model plus parakeet-class
 * STT on a serving runtime with model residency + concurrency (mlx/omlx on Apple silicon, a CUDA
 * equivalent elsewhere). See docs/model-support-matrix.md for the BASIC → JUDGE tier ladder; whisper.cpp
 * here is the CPU fallback, slower than parakeet-class STT on a served runtime.
 */
export const seededStarterModels: StarterModels = {
  id: 'starter-models-default',
  version: 1,
  description:
    'Vetted small local models the engine can download and run at tier zero (no server installed). Never auto-downloaded — fetched only on an explicit click.',
  models: [
    {
      id: 'qwen3-1.7b-q4',
      slot: 'llm',
      runtime: 'llama.cpp',
      name: 'Qwen3 1.7B (Q4_K_M)',
      filename: 'Qwen_Qwen3-1.7B-Q4_K_M.gguf',
      url: 'https://huggingface.co/bartowski/Qwen_Qwen3-1.7B-GGUF/resolve/main/Qwen_Qwen3-1.7B-Q4_K_M.gguf',
      sizeBytes: 1_280_000_000,
      description: 'Current-generation, small and CPU-friendly — warms fast, the first-run default. Tier-zero warm-up, not the real-time fast tier. Apache-2.0, ungated.',
    },
    {
      id: 'qwen3-4b-q4',
      slot: 'llm',
      runtime: 'llama.cpp',
      name: 'Qwen3 4B (Q4_K_M)',
      filename: 'Qwen_Qwen3-4B-Q4_K_M.gguf',
      url: 'https://huggingface.co/bartowski/Qwen_Qwen3-4B-GGUF/resolve/main/Qwen_Qwen3-4B-Q4_K_M.gguf',
      sizeBytes: 2_500_000_000,
      description: 'A step up in quality for a little more memory. Still tier-zero — the recommended fast tier is an ~8B-class model on a served runtime. Apache-2.0, ungated.',
    },
    {
      id: 'whisper-base-en',
      slot: 'stt',
      runtime: 'whisper.cpp',
      name: 'Whisper base.en',
      filename: 'ggml-base.en.bin',
      url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
      sizeBytes: 147_960_000,
      description: 'Tiny English transcription on CPU — the tier-zero audio fallback. Slower than parakeet-class STT on a served runtime (the recommended real-time path).',
    },
    {
      id: 'whisper-small-en',
      slot: 'stt',
      runtime: 'whisper.cpp',
      name: 'Whisper small.en',
      filename: 'ggml-small.en.bin',
      url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin',
      sizeBytes: 487_600_000,
      description: 'More accurate English transcription for a larger download — still the CPU fallback, slower than parakeet-class STT on a served runtime.',
    },
  ],
}
