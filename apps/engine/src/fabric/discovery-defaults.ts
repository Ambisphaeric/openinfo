import type { CapabilityMap, ProbeList } from '@openinfo/contracts'

/**
 * Seeded discovery documents — the well-known local servers to probe and the name→slot classifier.
 * These are DOCUMENTS (everything user-configurable is a document): seeded only when absent, versioned
 * in _meta.db, editable via the store. They mirror the validated examples in shared/contracts/examples/
 * probeList.default.json + capabilityMap.default.json. Ports are conventions, not truth — GET /v1/models
 * decides what is actually loaded, which is also the false-positive guard (a random dev server on :8000
 * that is not OpenAI-shaped simply fails to return a model list and is reported not-reachable).
 */
export const seededProbeList: ProbeList = {
  id: 'probes-default',
  version: 1,
  description:
    'Well-known local model servers discovery probes on this machine. Conventions, not truth — GET {url}/v1/models decides what is actually loaded. Edit this document to add a nonstandard port or host.',
  probes: [
    // omlx (Apple-silicon MLX server) speaks OpenAI-compat on :8000 but demands a bearer even on
    // localhost — the keyRef lets discovery retry with a stored secret and enumerate it; with no key
    // stored the server is still surfaced as authRequired (present, needs a key), never a silent miss.
    { name: 'omlx', url: 'http://localhost:8000', keyRef: 'api_d' },
    { name: 'lm-studio', url: 'http://localhost:1234' },
    { name: 'ollama', url: 'http://localhost:11434' },
    { name: 'kokoro', url: 'http://localhost:8880' },
    { name: 'whisper-cpp', url: 'http://localhost:8080' },
  ],
}

export const seededCapabilityMap: CapabilityMap = {
  id: 'capability-map-default',
  version: 1,
  description:
    'Classify a model into capability slots by its NAME. Substrings are lowercased; a model matching several rules gets the UNION of their slots (a vision-language model is both vlm and llm). default applies only when no rule matches.',
  rules: [
    { any: ['embed'], slots: ['embed'] },
    { any: ['ocr'], slots: ['ocr'] },
    { any: ['-vl', 'vlm', 'vision'], slots: ['vlm', 'llm'] },
    { any: ['whisper', 'parakeet'], slots: ['stt'] },
    { any: ['kokoro', 'tts'], slots: ['tts'] },
  ],
  default: ['llm'],
}
