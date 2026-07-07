# engine/voice — Phase 2 (dials), Phase 5 (comparator)
- `resolve.ts` — binding resolution: session > workspace > mode > global → dial vector
- `interpolate.ts` — dial vector → template variables + compiled guidance ({{voice.rules}})
- `comparator.ts` (P5) — detected_register per merge window vs bound register
- `chains.ts` (P5) — escalation chain executor (glyph → card → tts), per-mode config
