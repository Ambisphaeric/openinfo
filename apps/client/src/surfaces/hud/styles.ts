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

.hud{width:660px;max-width:100%;border-radius:15px;overflow:hidden;
  background:var(--s-glass);backdrop-filter:blur(20px);border:1px solid var(--s-line);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.07), 0 34px 70px -24px rgba(0,0,0,.8)}
.hud.compact{width:560px}

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

/* Boot/runtime status chip (boot.ts): a transparent window must never fail invisibly — while the
   engine is unreachable this is the ONLY painted pixel. Empty (healthy) ⇒ hidden entirely. */
.hud-boot-status{position:fixed;top:14px;left:50%;transform:translateX(-50%);max-width:88%;
  font-family:var(--s-mono);font-size:11px;line-height:1.5;color:#e8b26a;text-align:center;
  background:rgba(12,14,19,.92);border:1px solid rgba(217,161,59,.45);border-radius:8px;
  padding:6px 12px;pointer-events:none;z-index:9}
.hud-boot-status:empty{display:none}
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
