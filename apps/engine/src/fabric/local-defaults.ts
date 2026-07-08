import type { StarterModels } from '@openinfo/contracts'

/**
 * Seeded starter models (ARCHITECTURE §8 tier zero, slice c). A DOCUMENT (everything user-configurable
 * is a document): seeded only when absent, versioned in _meta.db, editable via the store. Mirrors the
 * validated example in shared/contracts/examples/starterModels.default.json.
 *
 * Choices (2026-07, honest current defaults): llm → llama.cpp GGUF chat models from bartowski
 * (Qwen2.5 1.5B/3B Instruct — Apache-2.0, ungated, no HF login); the 1.5B is the first-run default
 * because it warms fast (the cold-35B gotcha the discovery slice recorded). stt → whisper.cpp ggml
 * models from ggerganov/whisper.cpp (base.en / small.en). Sizes are approximate — stated honestly in
 * the UI; the real integrity check at download time is the server Content-Length + a truncation floor.
 */
export const seededStarterModels: StarterModels = {
  id: 'starter-models-default',
  version: 1,
  description:
    'Vetted small local models the engine can download and run at tier zero (no server installed). Never auto-downloaded — fetched only on an explicit click.',
  models: [
    {
      id: 'qwen2.5-1.5b-instruct-q4',
      slot: 'llm',
      runtime: 'llama.cpp',
      name: 'Qwen2.5 1.5B Instruct (Q4_K_M)',
      filename: 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf',
      url: 'https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf',
      sizeBytes: 1_120_000_000,
      description: 'Small, fast, warms quickly — the first-run default. Apache-2.0, ungated.',
    },
    {
      id: 'qwen2.5-3b-instruct-q4',
      slot: 'llm',
      runtime: 'llama.cpp',
      name: 'Qwen2.5 3B Instruct (Q4_K_M)',
      filename: 'Qwen2.5-3B-Instruct-Q4_K_M.gguf',
      url: 'https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/main/Qwen2.5-3B-Instruct-Q4_K_M.gguf',
      sizeBytes: 1_930_000_000,
      description: 'A step up in quality for a little more memory. Apache-2.0, ungated.',
    },
    {
      id: 'whisper-base-en',
      slot: 'stt',
      runtime: 'whisper.cpp',
      name: 'Whisper base.en',
      filename: 'ggml-base.en.bin',
      url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
      sizeBytes: 147_960_000,
      description: 'Tiny English transcription model — the tier-zero audio path.',
    },
    {
      id: 'whisper-small-en',
      slot: 'stt',
      runtime: 'whisper.cpp',
      name: 'Whisper small.en',
      filename: 'ggml-small.en.bin',
      url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin',
      sizeBytes: 487_600_000,
      description: 'More accurate English transcription for a larger download.',
    },
  ],
}
