# templates — the gallery (documents ONLY, no code; that is the openness proof)
Each template = surface.json + mode.json + registers.json + chains (in mode) + flags.json.
| dir | ships | proves |
|---|---|---|
| openinfo-hud | P2 | the live join (launch anchor) |
| glass-minimal | P2 | the floor: two-button pill |
| meeting-companion | P3 | meetily-shaped standalone pipeline |
| interview | P5 | voice binding + diarization flag |
| deep-work | P4 | router + ledger without meetings |

**Shipped so far (P2):** `openinfo-hud/surface.json` (template #1, the launch anchor — identical to
the engine-seeded default `surf-openinfo-hud`) and `glass-minimal/surface.json` (template #3, the
floor: Now line + a collapsed moments stream). Both are pure layout documents — the same block
renderer produces two different HUDs from them, which is the openness proof. They reference the
shipped builtin `mode-meeting` and registers by id rather than re-declaring them; a template's own
`mode.json`/`registers.json`/`flags.json` are added only when it needs to diverge from the builtins.
Glass Minimal's interactive two-button capture pill (mic/screen toggles) is the palette (P6); it
ships now as the minimal readout surface.
