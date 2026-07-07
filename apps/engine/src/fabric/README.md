# engine/fabric — Phase 1
Capability slots (stt/tts/llm/vlm/ocr/embed) → ordered endpoint lists.
- `slots.ts` — resolution + fallback
- `endpoints/local.ts`, `endpoints/http.ts` (P1) · `endpoints/cloud.ts` (P7, keychain auth)
- `bench.ts` — measured tok/s + latency per endpoint (feeds envelope math)
- `health.ts` — liveness; first-healthy-wins
Modes/blocks reference slot names only — never a vendor or model id.
