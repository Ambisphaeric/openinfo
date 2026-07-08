import type { FabricProfile } from '@openinfo/contracts'

/**
 * Seeded example fabric profiles — the starter configs a first run gets to inspect, clone, and
 * activate (never a verdict: a user composes their own map across hosts). These mirror the validated
 * examples in shared/contracts/examples/fabricProfile.*.json. They are seeded as DOCUMENTS only when
 * absent, and are INERT until explicitly activated — seeding them does not change what GET /fabric
 * returns (the live fabric stays the legacy/empty map until a user opts in), so the quickstart's
 * empty-llm-slot promise holds. None carries a key: `remote-http-template` references keys by keyRef.
 */
export const seededProfiles: readonly FabricProfile[] = [
  {
    id: 'lm-studio-local',
    name: 'LM Studio (local)',
    version: 1,
    description: 'An 8B-class model served by LM Studio on this Mac (OpenAI-compatible on :1234). No key needed — localhost.',
    fabric: {
      slots: {
        stt: [],
        tts: [],
        llm: [{ kind: 'http', name: 'lm-studio', url: 'http://localhost:1234', api: 'openai-compat', model: 'local-model' }],
        vlm: [],
        ocr: [],
        embed: [],
      },
    },
  },
  {
    id: 'ollama-local',
    name: 'Ollama (local)',
    version: 1,
    description: 'Ollama on this Mac, OpenAI-compatible on :11434 — a small chat model plus a local embedder. No key needed.',
    fabric: {
      slots: {
        stt: [],
        tts: [],
        llm: [{ kind: 'http', name: 'ollama', url: 'http://localhost:11434', api: 'openai-compat', model: 'llama3.2:3b' }],
        vlm: [],
        ocr: [],
        embed: [{ kind: 'http', name: 'ollama-embed', url: 'http://localhost:11434', api: 'openai-compat', model: 'nomic-embed-text' }],
      },
    },
  },
  {
    id: 'remote-http-template',
    name: 'Remote hosts (template)',
    version: 1,
    description:
      'A template for a multi-host rig: a bigger LLM on one box and STT on another, reached over http (LAN or tailscale). Each authed endpoint names a key by keyRef — set the values via PUT /fabric/secrets/:ref; they never live in this document. Clone this, edit the URLs/models, wire your keys, then activate.',
    fabric: {
      slots: {
        // Placeholder URLs are deliberately localhost — a made-up LAN IP reads as a real machine
        // on the user's own subnet (it happened). Replace host:port with your actual boxes.
        stt: [{ kind: 'http', name: 'remote-stt', url: 'http://localhost:9000', api: 'openai-compat', auth: { keyRef: 'remote-stt-key' } }],
        tts: [],
        llm: [{ kind: 'http', name: 'remote-llm', url: 'http://localhost:8000', api: 'openai-compat', model: 'qwen3-27b', auth: { keyRef: 'remote-llm-key' } }],
        vlm: [],
        ocr: [],
        embed: [],
      },
    },
  },
]
