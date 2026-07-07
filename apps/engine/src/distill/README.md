# engine/distill — Phase 2
- `merge.ts` — rolling merge (30s → 2m), token-budgeted per pass
- `templates/` — prompt templates; ALL templates interpolate voice dials ({{charm}}, {{voice.rules}})
- `moments.ts` — typed moment extraction (● ◆ ▲ ✱) riding the same pass
- `ocr.ts` (P3) — screen-text distillation via the ocr slot
