# templates — the gallery (documents ONLY, no code; that is the openness proof)
Each template = surface.json + mode.json + registers.json + chains (in mode) + flags.json.
| dir | ships | proves |
|---|---|---|
| openinfo-hud | P2 | the live join (launch anchor) |
| openinfo-fields | P4 (#100) | the fast-fields canon as a companion app |
| openinfo-notetaker | P4 (#133) | the Meetily-shape three-zone note-taker (look-and-speed exemplar) |
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

**Also shipped (P4):** `openinfo-fields/surface.json` (#100, mirrors the seeded `surf-openinfo-fields`)
and `openinfo-notetaker/surface.json` (#133, mirrors the seeded `surf-openinfo-notetaker`) — the
meeting note-taker, the mainstream look-and-speed exemplar. It composes ONLY existing block types and
query sources into a three-zone Meetily-shape layout, and proves layout can go beyond one vertical
stack WITHOUT a new block type or a contract change: each block names its column through an
`nt-left-`/`nt-center-`/`nt-right-` id PREFIX, and the client `notetaker-layout.ts` partitions the flat
stack by that prefix and renders each zone through the SAME `renderSurface` — the document, not the
renderer, owns the columns. LEFT = pins + rail chrome (home/nav/folders), CENTER = the now/moments/
distillates canvas with the relocated Record affordance, RIGHT = the rolling-summary distillate stream
+ action items + fast fields. The record button is an honest inert placeholder (in-window capture
start/stop needs the unbuilt #136 session-control block; the tray is the control today).
