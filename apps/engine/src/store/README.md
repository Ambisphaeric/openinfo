# engine/store — Phase 1 core, Phase 3 growth (loom transplant)
loom packages/store + sqlite-vec adapter. Additions here:
- `workspace-registry.ts` — ONE SQLITE FILE PER WORKSPACE; open/create/close/export/delete by file
- `graph.ts` (P3) — cross-workspace entity graph, edges only
- `layouts.ts` (P2) — surface/mode/register/flag documents (versioned config records)
No other module opens a DB handle. Ever.
