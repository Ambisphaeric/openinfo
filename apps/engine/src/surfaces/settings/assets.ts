import { SETUP_CSS, SETUP_SCRIPT } from '../setup/assets.js'
import { FEATURES_SCRIPT } from './sections/features.js'

/**
 * Static assets for the Settings sidebar shell. SETTINGS_CSS extends the setup palette (SETUP_CSS —
 * reused so the re-homed section fragments keep their component styles) with a disciplined sidebar
 * layout and a unified control system: one type scale, one set of inputs/buttons/toggles with shared
 * hover/active/focus states, real cards, and a proper toggle switch. The design language follows
 * design/renderings/hud-v2.html (dark glass, orange accent, mono micro-labels). This must read as real
 * software, not a toy (owner acceptance criterion) — so the effort here is deliberate, not polish.
 *
 * SETTINGS_SCRIPT composes the existing setup browser wiring (models/profiles/keys/starter/try-it,
 * SETUP_SCRIPT) with the Features toggle wiring (FEATURES_SCRIPT). The sidebar itself is plain
 * server-rendered anchors — no client routing. Authored so it embeds safely in a template.
 */
export const SETTINGS_CSS =
  SETUP_CSS +
  `
:root{
  --radius:12px;--radius-sm:8px;--radius-xs:6px;
  --bg0:#0c0e13;--bg1:#14171e;--bg2:#1b1f28;
  --surface:#15181f;--surface-2:#181c24;
  --line-soft:rgba(255,255,255,.055);--line-mid:rgba(255,255,255,.10);
  --ink-2:#c6cbd4;
  --accent-soft:rgba(224,106,60,.12);--accent-line:rgba(224,106,60,.45);
  --ok-soft:rgba(77,164,122,.12);
  --shadow:0 24px 60px -34px rgba(0,0,0,.75);
  --sidebar-w:250px;
}
/* ---------- shell layout ---------- */
body.settings{padding:0;background:
  radial-gradient(1200px 520px at 78% -14%,#1a2130 0%,transparent 58%),
  radial-gradient(760px 480px at -6% 108%,#161d26 0%,transparent 52%),
  var(--bg0);min-height:100vh;-webkit-font-smoothing:antialiased}
.app{display:grid;grid-template-columns:var(--sidebar-w) minmax(0,1fr);min-height:100vh;align-items:start}
/* ---------- sidebar ---------- */
.sidebar{position:sticky;top:0;height:100vh;overflow-y:auto;padding:22px 14px 28px;
  border-right:1px solid var(--line-soft);background:linear-gradient(180deg,rgba(20,23,30,.6),rgba(12,14,19,.6))}
.brand{display:flex;align-items:baseline;gap:8px;padding:4px 10px 20px;flex-wrap:wrap}
.brand-name{font-size:16px;font-weight:680;letter-spacing:-.02em;color:var(--ink)}
.brand-sub{font-size:12px;color:var(--muted);font-weight:500}
.brand-engine{margin-left:auto;font-family:var(--mono);font-size:10.5px;color:var(--faint);
  border:1px solid var(--line-soft);border-radius:5px;padding:2px 7px}
.nav-group{margin-top:14px}
.nav-group:first-of-type{margin-top:0}
.nav-glabel{font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;
  color:var(--faint);padding:0 12px 7px}
.nav-item{display:flex;align-items:center;gap:9px;padding:8px 12px;margin:2px 0;border-radius:var(--radius-sm);
  color:var(--ink-2);font-size:13.5px;font-weight:500;text-decoration:none;position:relative;
  transition:background .12s ease,color .12s ease}
.nav-item:hover{background:rgba(255,255,255,.045);color:var(--ink);text-decoration:none}
.nav-item:focus-visible{outline:2px solid var(--accent-line);outline-offset:1px}
.nav-item.active{background:var(--accent-soft);color:var(--ink)}
.nav-item.active::before{content:"";position:absolute;left:0;top:8px;bottom:8px;width:3px;border-radius:0 3px 3px 0;background:var(--accent)}
.nav-label{flex:1;min-width:0}
.nav-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--faint);box-shadow:0 0 0 3px rgba(255,255,255,.02)}
.nav-dot.on{background:var(--ok);box-shadow:0 0 0 3px var(--ok-soft)}
.nav-count{font-family:var(--mono);font-size:10px;color:var(--muted);border:1px solid var(--line-soft);
  border-radius:20px;min-width:18px;text-align:center;padding:1px 6px}
.nav-count.on{color:var(--accent);border-color:var(--accent-line)}
/* ---------- content pane ---------- */
.pane{padding:38px max(28px,4vw) 90px;max-width:900px}
.pane-head{margin-bottom:22px}
.pane-head h1{font-size:25px;font-weight:660;letter-spacing:-.02em;margin:0}
.pane-body>.sub:first-child{margin-top:-4px;max-width:70ch;font-size:13.5px}
.pane-body h2{margin-top:30px}
/* the first-run nudge */
.pane .banner{margin:0 0 20px;border-radius:var(--radius)}
/* ---------- unified controls ---------- */
.pane button{border-radius:var(--radius-xs);padding:6px 13px;font-weight:550;transition:border-color .12s,background .12s,color .12s}
.pane button:hover{border-color:var(--muted);background:#20242d}
.pane button:focus-visible{outline:2px solid var(--accent-line);outline-offset:1px}
.pane button.primary:hover{background:#e8794d;border-color:#e8794d}
.pane button:disabled{opacity:.5;cursor:not-allowed}
.pane button:disabled:hover{border-color:var(--line);background:#1b1f28}
.pane input,.pane select,.pane textarea{transition:border-color .12s,box-shadow .12s}
.pane input:focus,.pane select:focus,.pane textarea:focus{outline:none;border-color:var(--accent-line);
  box-shadow:0 0 0 3px var(--accent-soft)}
.card{border-radius:var(--radius);box-shadow:var(--shadow)}
/* ---------- Features ---------- */
.feat-count{display:inline-block;font-family:var(--mono);font-size:11px;color:var(--accent);
  border:1px solid var(--accent-line);border-radius:20px;padding:3px 11px;margin:4px 0 18px}
.feat-stage{margin-bottom:22px}
.feat-stage-head{display:flex;align-items:baseline;gap:10px;font-family:var(--mono);font-size:11px;font-weight:600;
  letter-spacing:.12em;text-transform:uppercase;color:var(--accent);padding:0 2px 10px;border-bottom:1px solid var(--line-soft);margin-bottom:4px}
.feat-stage-note{font-family:system-ui,-apple-system,sans-serif;font-size:12px;font-weight:400;letter-spacing:0;
  text-transform:none;color:var(--faint)}
.feat{display:grid;grid-template-columns:auto 1fr;gap:14px;align-items:start;padding:14px 12px;
  border-radius:var(--radius-sm);transition:background .12s}
.feat:hover{background:rgba(255,255,255,.02)}
.feat.on{background:linear-gradient(90deg,var(--accent-soft),transparent 60%)}
.feat-body{min-width:0}
.feat-head{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap}
.feat-label{font-size:14px;font-weight:600;color:var(--ink)}
.feat-key{font-family:var(--mono);font-size:10.5px;color:var(--faint)}
.feat-note{color:var(--muted);font-size:12.5px;margin-top:4px;max-width:66ch;line-height:1.5}
.feat-deps{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
.dep{font-family:var(--mono);font-size:10.5px;padding:2px 8px;border-radius:5px;border:1px solid var(--line-soft);color:var(--muted)}
.dep.ok{color:var(--ok);border-color:rgba(77,164,122,.4)}
.dep.unmet{color:var(--warn);border-color:rgba(217,161,59,.4)}
.tier-chip{font-family:var(--mono);font-size:9.5px;letter-spacing:.06em;color:var(--muted);
  border:1px solid var(--line-soft);border-radius:4px;padding:1px 6px}
/* the toggle switch */
.feat-switch{position:relative;display:inline-flex;flex:none;cursor:pointer;padding-top:2px}
.feat-switch input{position:absolute;opacity:0;width:0;height:0}
.feat-switch .track{width:38px;height:22px;border-radius:22px;background:var(--bg2);border:1px solid var(--line-mid);
  position:relative;transition:background .16s ease,border-color .16s ease}
.feat-switch .track::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;
  background:#cfd4dd;transition:transform .16s ease,background .16s ease}
.feat-switch input:checked+.track{background:var(--accent);border-color:var(--accent)}
.feat-switch input:checked+.track::after{transform:translateX(16px);background:#150c07}
.feat-switch input:focus-visible+.track{outline:2px solid var(--accent-line);outline-offset:2px}
.feat-switch input:disabled+.track{opacity:.5;cursor:progress}
/* ---------- Status / Diagnostics ---------- */
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin-top:4px}
.stat-card{margin-bottom:0}
.stat-title{font-family:var(--mono);font-size:10.5px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;
  color:var(--faint);margin-bottom:12px}
.stat-row{display:flex;align-items:baseline;gap:12px;padding:5px 0;font-size:13px}
.stat-key{color:var(--muted);min-width:96px;flex:none}
.stat-val{color:var(--ink);min-width:0}
.stat-mono{font-family:var(--mono);font-size:11px;color:var(--faint)}
.stat-dot{font-size:9px;margin-right:5px;vertical-align:1px}
.stat-dot.on{color:var(--ok)}.stat-dot.off{color:var(--faint)}
.stat-slots{margin-top:10px;border-top:1px solid var(--line-soft);padding-top:8px}
.stat-slot{display:flex;align-items:baseline;gap:8px;padding:3px 0;font-size:12.5px}
.stat-slot-key{font-family:var(--mono);font-size:11px;color:var(--accent);min-width:46px;text-transform:uppercase}
.stat-slot-detail{color:var(--muted);min-width:0}
.stat-note{margin-top:10px;font-size:12px}
.stat-fail-class{font-family:var(--mono);font-size:11px;color:var(--bad);text-transform:uppercase;letter-spacing:.06em}
.stat-hint{color:var(--warn)}
.gate-chain{display:flex;flex-wrap:wrap;gap:6px 12px;margin:6px 0 2px;padding-left:2px}
.gate{display:inline-flex;align-items:baseline;font-size:11.5px;color:var(--muted)}
.gate.ok{color:var(--muted)}
.gate.block{color:var(--bad);font-weight:600}
.gate.off{color:var(--faint)}
.stat-defer{margin-top:20px;font-size:12px;color:var(--faint);border-top:1px solid var(--line-soft);
  padding-top:14px;max-width:74ch;line-height:1.55}
/* ---------- Privacy ---------- */
.priv-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin-top:4px}
.priv-card{margin-bottom:0}
.priv-what{font-size:13px;color:var(--ink-2);line-height:1.5}
.priv-where{margin-top:9px;font-size:12px;color:var(--muted);font-family:var(--mono);line-height:1.5}
/* ---------- Benchmarks (present-but-future placeholder) ---------- */
.future{border:1px dashed var(--line-mid);background:linear-gradient(180deg,rgba(255,255,255,.015),transparent);
  border-radius:var(--radius);padding:20px}
.future-badge{display:inline-block;font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--warn);border:1px solid rgba(217,161,59,.4);border-radius:20px;padding:3px 10px;margin-bottom:12px}
.future h3{font-size:15px;font-weight:620;margin:0 0 8px;color:var(--ink)}
.future p{color:var(--muted);font-size:13px;line-height:1.6;max-width:70ch;margin:0 0 12px}
.future ul{margin:0 0 6px;padding-left:18px;color:var(--muted);font-size:13px;line-height:1.7}
.future ul .mono{color:var(--ink-2)}
/* ---------- Audit ledger (#65) ---------- */
.ldg-summary{display:flex;flex-wrap:wrap;gap:6px 20px;margin:4px 0 14px;font-size:13px;color:var(--ink-2)}
.ldg-summary .n{font-family:var(--mono);color:var(--ink);font-weight:600}
.ldg-scroll{overflow-x:auto;border-radius:var(--radius);border:1px solid var(--line-soft)}
.ldg-table{width:100%;border-collapse:collapse;font-size:12.5px;min-width:640px}
.ldg-table th{text-align:left;font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--faint);font-weight:600;padding:9px 12px;border-bottom:1px solid var(--line-soft);white-space:nowrap}
.ldg-table td{padding:8px 12px;border-bottom:1px solid var(--line-soft);vertical-align:top}
.ldg-table tr:last-child td{border-bottom:0}
.ldg-stage{font-family:var(--mono);color:var(--accent);text-transform:uppercase;font-size:11px}
.ldg-ep{color:var(--ink-2)}
.ldg-model{font-family:var(--mono);font-size:11px;color:var(--faint)}
.ldg-tok{font-family:var(--mono);color:var(--ink);white-space:nowrap}
.ldg-est{color:var(--warn);font-size:10.5px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.05em}
.ldg-absent{color:var(--faint);font-style:italic}
.ldg-local{color:var(--muted);font-family:var(--mono);font-size:11px}
.ldg-egress{color:var(--warn);font-family:var(--mono);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em}
.ldg-when{font-family:var(--mono);font-size:11px;color:var(--faint);white-space:nowrap}
.ldg-note{margin-top:16px;font-size:12px;color:var(--faint);border-top:1px solid var(--line-soft);
  padding-top:14px;max-width:76ch;line-height:1.55}
@media (max-width:720px){
  .app{grid-template-columns:1fr}
  .sidebar{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line-soft)}
  .pane{padding:26px 18px 70px}
}
`

/** All browser wiring for the shell: the reused setup wiring + the Features toggle wiring. */
export const SETTINGS_SCRIPT = SETUP_SCRIPT + '\n' + FEATURES_SCRIPT
