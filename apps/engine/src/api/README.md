# engine/api — Phase 1
HTTP + WS server; one handler file per resource (`routes/sessions.ts`, `routes/modes.ts`, …).
Everything the client and workbench see goes through here. Later: `routes/recall.ts` (P3),
`routes/ledger.ts` (P4), `routes/layouts.ts` + custom-block sandbox bridge endpoints (P6).
