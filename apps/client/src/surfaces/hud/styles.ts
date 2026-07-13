/**
 * The HUD stylesheet, ported from design/renderings/hud-v2.html (the versioned design source of
 * truth) — the panel chrome, the ● ◆ ▲ ✱ mark colours, the relevant-now rows, the moments stream,
 * the `.mini` action buttons and the answer-ready hint strip. Kept as a string constant (no bundler
 * in the client yet) so the dev entry can inject it and the block-renderer markup lands recognizably.
 * Theme-aware: honours prefers-color-scheme and an explicit :root[data-theme].
 */
export const hudStyles = `
:root{
  --page-bg:#f4f5f7; --page-ink:#1b1e24; --page-line:#d9dce2;
  --accent:#e06a3c;
  --m-commit:#e06a3c; --m-quest:#d9a13b; --m-decide:#4da47a; --m-artifact:#6f9ecf;
  --s-bg0:#0c0e13; --s-glass:rgba(21,24,32,.84);
  --s-line:rgba(255,255,255,.09); --s-line-soft:rgba(255,255,255,.05);
  --s-ink:#e9ebef; --s-muted:#9aa0ab; --s-faint:#6b7280;
  --s-mono:ui-monospace,'SF Mono',SFMono-Regular,Menlo,monospace;
}
@media (prefers-color-scheme: light){ :root{ --page-bg:#f4f5f7; } }
:root[data-theme="dark"]{ --page-bg:#101216; }
:root[data-theme="light"]{ --page-bg:#f4f5f7; }

*{box-sizing:border-box}
body{margin:0;background:var(--page-bg);
  font-family:system-ui,-apple-system,'SF Pro Text','Helvetica Neue',sans-serif;
  line-height:1.55;-webkit-font-smoothing:antialiased}

.stage{min-height:100vh;display:flex;justify-content:center;align-items:flex-start;
  padding:48px 24px;color:var(--s-ink);font-size:13px;
  background:
    radial-gradient(1100px 460px at 72% -12%, #222936 0%, transparent 60%),
    radial-gradient(800px 460px at 8% 112%, #1a2028 0%, transparent 55%),
    var(--s-bg0)}

/* S5 clip mechanism: the panel is FLUID — it fills the window up to a 660px cap, never a fixed 660px that
   overflows a narrower window. With .stage flex-CENTERED, any panel wider than its window overflowed on BOTH
   edges, and the left overflow was unreachable (you cannot scroll a frameless content-sized window left) —
   so a window narrower than ~684px (fields 480, sidebar 320, glass-minimal 520, diagnostics 560) silently
   lost content off both sides. width:100%+max-width caps the panel AT the window width so it can never
   overflow; min-width:0 lets its grid/flex children shrink (their default min-width:auto was what forced the
   overflow). Every surface inherits this — no per-window patch. The wide default HUD still renders at 660. */
.hud{width:100%;max-width:660px;min-width:0;border-radius:15px;overflow:hidden;
  background:var(--s-glass);backdrop-filter:blur(20px);border:1px solid var(--s-line);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.07), 0 34px 70px -24px rgba(0,0,0,.8)}
.hud.compact{max-width:560px}

.hudtop{display:flex;align-items:baseline;gap:10px;padding:14px 18px 4px;
  cursor:grab;-webkit-user-select:none;user-select:none}
.hudtop:active{cursor:grabbing}
.hudtop .mini,.hudtop [data-verb]{cursor:default}
.hudtop .ctx{font-size:15px;font-weight:650;color:var(--s-ink);letter-spacing:-.01em}
.hudtop .ctx .ws{color:var(--s-muted);font-weight:450}
.hudtop .el{font-family:var(--s-mono);font-size:10.5px;color:var(--s-faint)}
.hudtop .st{margin-left:auto;display:flex;align-items:center;gap:7px}
.livedot{width:8px;height:8px;border-radius:50%;background:var(--m-commit);animation:pulse 1.8s ease-in-out infinite}
.livedot.off{background:var(--s-faint);animation:none}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.nowline{padding:2px 18px 13px;font-size:12.5px;color:var(--s-muted);border-bottom:1px solid var(--s-line-soft)}
.nowline b{color:#c9cdd5;font-weight:500}

.hgroup{padding:11px 18px 5px}
.hgroup .glbl{font-family:var(--s-mono);font-size:9.5px;letter-spacing:.15em;text-transform:uppercase;color:var(--s-faint);margin-bottom:7px}

.rel{display:grid;grid-template-columns:16px 1fr auto;gap:10px;padding:8px 0;border-bottom:1px solid var(--s-line-soft);align-items:start}
.rel:last-child{border-bottom:none}
.rel .mk{padding-top:3px;text-align:center;font-size:10px;line-height:1}
.rel .body .ttl{font-size:12.5px;font-weight:600;color:var(--s-ink);line-height:1.4}
.rel .body .ttl .ext{font-family:var(--s-mono);font-size:10px;color:var(--s-faint);font-weight:400}
.rel .body .why{font-size:11.5px;color:var(--s-muted);line-height:1.5;margin-top:1px}
.rel .go{display:flex;gap:6px;padding-top:2px}
.mini{padding:3px 10px;border-radius:6px;font-size:10.5px;font-weight:600;border:1px solid var(--s-line);color:var(--s-ink);background:rgba(27,31,40,.9);white-space:nowrap;cursor:pointer}
.mini.ghost{background:transparent;color:var(--s-muted);font-weight:500}
/* Transient copy feedback (mount.ts paints these onto the clicked button; a failed copy must be
   visible, never a silent no-op — #43). Reverts after ~1.2s or on the next live re-render. */
.mini.copied{border-color:rgba(77,164,122,.55);color:#7cc4a0;background:rgba(77,164,122,.14)}
.mini.copyfail{border-color:rgba(224,106,60,.6);color:#e0865c;background:rgba(224,106,60,.14)}

/* Field micro-state dot (#66): a dot-scale, colour-coded judge tier — provisional/confirmed/corrected by
   default, document-configurable per surface. A few px, inline before the row title. Renders ONLY when an
   item carries a state (the honesty rule: nothing pretends to be reviewed; no judge stamps one yet). */
.dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:6px;vertical-align:middle;background:var(--s-faint)}
.dot.provisional{background:var(--m-quest)}
.dot.confirmed{background:var(--m-decide)}
.dot.corrected{background:var(--m-artifact)}
.dot.unknown{background:var(--s-faint)}

/* Glyph verb strip (#66): a compact ~60px reserve fitting three ~15px glyph buttons per row (default
   dismiss/pin/mark-for-follow-up). dismiss has a real write path; pin and mark-for-follow-up are
   honestly inert (.ghost) this slice. Success/failure paints via the shared .copied/.copyfail flip. */
.glyphs{display:inline-flex;gap:6px;align-items:center}
.gverb{width:18px;height:18px;padding:0;display:inline-flex;align-items:center;justify-content:center;
  font-size:12px;line-height:1;border-radius:5px;border:1px solid var(--s-line);color:var(--s-ink);
  background:rgba(27,31,40,.9);cursor:pointer}
.gverb.ghost{background:transparent;color:var(--s-faint);cursor:default}
.gverb.copied{border-color:rgba(77,164,122,.55);color:#7cc4a0;background:rgba(77,164,122,.14)}
.gverb.copyfail{border-color:rgba(224,106,60,.6);color:#e0865c;background:rgba(224,106,60,.14)}

/* #75 clarify affordance: the ≟ rides the .go glyph strip (a .gverb); when expanded, ONE inline ask line
   under the why. Never a modal — a single dismissible row. The choices are .mini-scale ✓-class buttons. */
.clarify-open{font-weight:700}
.clarify-ask{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:5px}
.clarify-ask .clarify-q{font-size:11px;color:var(--s-muted);margin-right:2px}
.clarify-choice{padding:2px 9px;border-radius:6px;font-size:10.5px;font-weight:600;border:1px solid var(--s-line);color:var(--s-ink);background:rgba(27,31,40,.9);white-space:nowrap;cursor:pointer}
.clarify-choice.ok{border-color:rgba(77,164,122,.45);color:#7cc4a0}
.clarify-choice.copied{border-color:rgba(77,164,122,.55);color:#7cc4a0;background:rgba(77,164,122,.14)}
.clarify-choice.copyfail{border-color:rgba(224,106,60,.6);color:#e0865c;background:rgba(224,106,60,.14)}
.clarify-dismiss{width:auto;padding:0 7px}

.mk.a{color:var(--m-artifact)} .mk.c{color:var(--m-commit)} .mk.q{color:var(--m-quest)}
.mk.d{color:var(--m-decide)} .mk.p{color:var(--s-muted)}

.streamwrap{max-height:224px;overflow:hidden;position:relative;padding-bottom:8px;margin:0 18px}
.streamwrap::after{content:"";position:absolute;left:0;right:0;bottom:0;height:30px;
  background:linear-gradient(transparent, rgba(21,24,32,.95));pointer-events:none}
.stream .rows{padding-bottom:6px}
.mo{display:grid;grid-template-columns:40px 14px 1fr;gap:9px;padding:6.5px 0;align-items:baseline;border-bottom:1px dashed var(--s-line-soft)}
.mo:last-child{border-bottom:none}
.mo .t{font-family:var(--s-mono);font-size:10px;color:var(--s-faint);font-variant-numeric:tabular-nums}
.mo .g{font-size:10px;text-align:center;line-height:1.5}
.mo .x{font-size:12px;color:#c3c8d1;line-height:1.5}
.mo .x b{color:var(--s-ink);font-weight:600}
.mo .x .unans{font-family:var(--s-mono);font-size:9.5px;color:var(--m-quest);margin-left:6px}

.hintrow{display:grid;grid-template-columns:16px 1fr;gap:10px;margin:10px 18px 2px;padding:9px 12px 10px;
  border:1px solid rgba(77,164,122,.3);background:rgba(77,164,122,.06);border-radius:9px}
.hintrow .hk{color:#7cc4a0;font-size:11px;padding-top:2px}
.hintrow .hx{font-size:12px;color:#c3c8d1;line-height:1.55}
.hintrow .hx b{color:var(--s-ink);font-weight:600}
.copybar{display:flex;align-items:center;gap:8px;margin-top:7px;border:1px solid var(--s-line);
  border-radius:7px;background:rgba(0,0,0,.25);padding:4px 5px 4px 10px}
.copybar .txt{flex:1;font-family:var(--s-mono);font-size:10px;color:#b7bcc6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

@media (prefers-reduced-motion: reduce){.livedot{animation:none}}

/* Live-transcript fast-path (#58): an EVENT-fed rolling strip of raw words, distinct from the distilled
   blocks. Sits at the bottom of the panel; a subtle top rule + monospace text mark it as the raw live
   layer. Oldest lines carry .fade as they age toward dropping. Honestly labeled "raw, not saved". */
.lt{margin:6px 18px 12px;padding-top:9px;border-top:1px solid var(--s-line-soft)}
/* Header row (#96): the "raw, not saved" label + the system-stream mute toggle, spaced apart. */
.lt-head{display:flex;align-items:baseline;justify-content:space-between;gap:9px}
/* System-stream mute toggle (#96): a quiet text affordance, not a loud button — hides the system-audio
   lane from THIS strip (capture keeps running). The .on class marks the muted state. */
.lt-mute{background:transparent;border:0;padding:0;cursor:pointer;font-family:var(--s-mono);font-size:9.5px;letter-spacing:.04em;text-transform:uppercase;color:var(--s-faint);white-space:nowrap}
.lt-mute:hover{color:var(--s-fg,#d8dce4)}
.lt-mute.on{color:var(--m-quest)}
/* Disclosure of what the mute is hiding — honest about the hidden count and that capture continues. */
.lt-muted-note{font-size:10px;color:var(--s-faint);font-style:italic;padding:2px 0 4px}
.lt-empty{font-size:11.5px;color:var(--s-faint);font-style:italic;padding:4px 0 2px}
.lt-rows{display:flex;flex-direction:column;gap:3px;max-height:132px;overflow:hidden}
.lt-line{display:grid;grid-template-columns:62px 1fr;gap:9px;align-items:baseline;font-size:11.5px;line-height:1.45;transition:opacity .4s ease}
.lt-line .lt-who{font-family:var(--s-mono);font-size:9.5px;letter-spacing:.04em;text-transform:uppercase;color:var(--s-faint);text-align:right}
.lt-line.mic .lt-who{color:var(--m-artifact)}
.lt-line.system .lt-who{color:var(--m-quest)}
.lt-line .lt-tx{color:#b7bcc6;font-family:var(--s-mono);font-size:11px}
.lt-line.fade{opacity:.42}
@media (prefers-reduced-motion: reduce){.lt-line{transition:none}}

/* Boot/runtime status chip (boot.ts): a transparent window must never fail invisibly — while the
   engine is unreachable this is the ONLY painted pixel. Empty (healthy) ⇒ hidden entirely. */
.hud-boot-status{position:fixed;top:14px;left:50%;transform:translateX(-50%);max-width:88%;
  font-family:var(--s-mono);font-size:11px;line-height:1.5;color:#e8b26a;text-align:center;
  background:rgba(12,14,19,.92);border:1px solid rgba(217,161,59,.45);border-radius:8px;
  padding:6px 12px;pointer-events:none;z-index:9}
.hud-boot-status:empty{display:none}

/* ── #133 meeting note-taker: the three-zone app frame (scoped to .nt-app) ──────────────────────────
   The Meetily-shape look-and-speed exemplar. renderNotetaker (notetaker-layout.ts) composes three
   renderSurface panels into this grid: LEFT rail (home/nav/folders/pins) · CENTER canvas (notes + AI
   summary, with the relocated Record affordance in its header) · RIGHT sidebar (enrichments — the rolling
   summary). The controller-composed #58 live-transcript strip (.lt) is parked as a full-width bottom
   ticker (the grid area named strip). Minimalist: quiet lines, one accent, columns split by hairline rules.
   Everything below is prefixed .nt- / .nt-app so it never touches the HUD/fields/diagnostics surfaces. */
.nt-app{width:100%;max-width:1220px;margin:0 auto;color:var(--s-ink);
  display:grid;grid-template-columns:220px minmax(0,1fr) 320px;grid-template-rows:minmax(0,1fr) auto;
  grid-template-areas:"left center right" "strip strip strip";gap:1px;
  min-height:calc(100vh - 24px);background:var(--s-line);border:1px solid var(--s-line);
  border-radius:14px;overflow:hidden;box-shadow:0 24px 60px -28px rgba(0,0,0,.7)}
.nt-left{grid-area:left;background:#0b0d12;display:flex;flex-direction:column;overflow-y:auto}
.nt-center{grid-area:center;background:var(--s-glass);display:flex;flex-direction:column;overflow-y:auto}
.nt-right{grid-area:right;background:#0b0d12;display:flex;flex-direction:column;overflow-y:auto}
/* The zone panels ARE the shared block renderer's .hud output — strip its glass/width chrome so it
   flows as a plain column body (the blocks keep their own row styling). */
.nt-app .hud{width:auto;max-width:none;background:transparent;backdrop-filter:none;border:0;
  border-radius:0;box-shadow:none;overflow:visible}
.nt-app .streamwrap{max-height:none;margin:0 18px}
.nt-app .streamwrap::after{display:none}

/* Left rail chrome */
.nt-rail-chrome{padding:14px 14px 6px;border-bottom:1px solid var(--s-line-soft)}
.nt-brand{display:flex;align-items:center;gap:9px;padding:2px 4px 12px}
.nt-home{width:26px;height:26px;border-radius:8px;border:1px solid var(--s-line);background:rgba(224,106,60,.14);
  color:var(--accent);font-size:13px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
.nt-brand-name{font-size:13.5px;font-weight:650;letter-spacing:-.01em;color:var(--s-ink)}
.nt-nav{display:flex;flex-direction:column;gap:2px;padding-bottom:10px}
.nt-navitem{text-align:left;padding:6px 9px;border-radius:7px;border:0;background:transparent;
  color:var(--s-muted);font-size:12px;font-weight:550;cursor:pointer}
.nt-navitem:hover{color:var(--s-ink);background:rgba(255,255,255,.04)}
.nt-navitem.active{color:var(--s-ink);background:rgba(255,255,255,.06)}
.nt-folders{padding:6px 0 2px}
.nt-folder{display:flex;align-items:center;gap:8px;padding:5px 9px;font-size:11.5px;color:var(--s-muted);cursor:default}
.nt-folder-glyph{color:var(--s-faint);font-size:9px}
.nt-folder-note{padding:2px 9px 4px 25px;font-size:9.5px;font-style:italic;color:var(--s-faint)}

/* Center canvas header + the relocated Record affordance (honest, inert placeholder — see #136) */
.nt-canvas-head{display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:13px 18px 11px;border-bottom:1px solid var(--s-line-soft)}
.nt-canvas-title{font-size:14px;font-weight:650;letter-spacing:-.01em;color:var(--s-ink)}
.nt-record{display:inline-flex;align-items:center;gap:7px;padding:6px 13px;border-radius:8px;
  font-size:11.5px;font-weight:650;cursor:pointer;border:1px solid var(--accent);color:var(--accent);
  background:rgba(224,106,60,.12)}
.nt-record-dot{width:8px;height:8px;border-radius:50%;background:var(--accent)}
/* pending = the in-window control isn't wired (needs #136); render it visibly-inert, never fake-live. */
.nt-record.pending{border-style:dashed;border-color:var(--s-line);color:var(--s-muted);
  background:transparent;cursor:default}
.nt-record.pending .nt-record-dot{background:var(--s-faint)}

/* Right sidebar header */
.nt-side-head{padding:13px 18px 9px;border-bottom:1px solid var(--s-line-soft);
  font-family:var(--s-mono);font-size:9.5px;letter-spacing:.15em;text-transform:uppercase;color:var(--s-faint)}

/* The live-transcript ticker, parked full-width across the bottom (controller-composed .lt) */
.nt-app > .lt{grid-area:strip;margin:0;padding:9px 18px 11px;border-top:1px solid var(--s-line);
  background:#0b0d12;max-height:120px;overflow-y:auto}

@media (max-width:900px){
  .nt-app{grid-template-columns:1fr;grid-template-areas:"center" "right" "left" "strip"}
}
`

/**
 * Debug outlines (?outline=1 — OPENINFO_HUD_OUTLINE / client.json `hudOutline`): the HUD window is
 * frameless and transparent, so when nothing paints there is nothing to SEE. Cyan = the window's full
 * bounds (the box macOS positions), orange = the .hud panel actually painted inside it. Appended after
 * hudStyles so it wins ties; inset outline on html so the window edge is visible on every display.
 */
export const hudOutlineStyles = `
html{outline:2px dashed #37b6d9;outline-offset:-2px}
.stage{outline:1px dashed rgba(55,182,217,.5);outline-offset:-1px}
.hud{outline:2px solid #e06a3c}
.hud-boot-status{pointer-events:none}
`
