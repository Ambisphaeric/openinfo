import type { FabricProfile } from '@openinfo/contracts'

/**
 * Seeded fabric profiles — the starter configs a first run gets to inspect, clone, and activate (never
 * a verdict: a user composes their own map across hosts). Seeded as DOCUMENTS only when absent, and
 * INERT until explicitly activated — seeding them does not change what GET /fabric returns (the live
 * fabric stays the legacy/empty map until a user opts in), so the quickstart's empty-llm-slot promise
 * holds.
 *
 * WHY THIS LIST IS ALMOST EMPTY: the offered configs must not name a model or port that a scan did not
 * actually see. The truthful source of a "LM Studio on :1234 serving X" or "omlx on :8000 serving Y"
 * offer is DISCOVERY (GET /fabric/discover) and the host SCAN (POST /fabric/scan) — they probe the real
 * ports and list the real model ids, then "Use this setup" writes the result as a profile. Hardcoded
 * `lm-studio-local`/`ollama-local` templates that named a fictional `local-model` / `llama3.2:3b` on a
 * fixed port described a rig nobody has; they are gone. The one seeded profile is the sanctioned
 * exception: an explicit MANUAL scaffold for a host a localhost scan can't reach (a remote/LAN/authed
 * box), naming no fictional model — clone it, set the URL/model, wire a key by keyRef if the host needs
 * one, then activate. It carries no key: the value lives in the engine secret store, referenced by ref.
 */
export const seededProfiles: readonly FabricProfile[] = [
  {
    id: 'remote-http-template',
    name: 'Manual endpoint (scaffold)',
    version: 1,
    description:
      'A blank scaffold for a host discovery can\'t auto-detect — a model server on another box (LAN or tailscale), or one behind a key. Clone it, then set the real URL and model in the Endpoints editor (or run Scan to fill them from a live host). If the host needs a key, reference it by keyRef and set the value under Settings → Keys; it never lives in this document. Names no model or port a scan hasn\'t confirmed.',
    fabric: {
      slots: {
        stt: [],
        tts: [],
        // A single placeholder llm endpoint to edit — deliberately the only concrete value, and only
        // because this IS the explicit manual template. No model id and no keyRef are invented: a scan
        // or the editor fills them from what the host actually serves.
        llm: [{ kind: 'http', name: 'my-endpoint', url: 'http://localhost:8000', api: 'openai-compat' }],
        vlm: [],
        ocr: [],
        embed: [],
      },
    },
  },
]
