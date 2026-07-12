/**
 * Styles for THE PILL (the-pill) — the compact header rectangle + docked panel, scoped to `.pill-app`.
 * Kept SEPARATE from hudStyles (the HUD chrome) and panelStyles (the #134 input/panel primitives) and
 * injected alongside them by dev-entry. Deliberately minimal — exact geometry / motion / the futuristic
 * conversation styling are the frontends design session; this is the honest functional glass-parity look.
 * Reuses the shared palette vars (--s-*, --accent) so it sits in the same visual system as the HUD.
 */
export const pillStyles = `
/* THE PILL FILLS ITS FIXED-width WINDOW. The mount div (dev-entry tags it .pill-mount for the pill) is a
   flex item of the centered .stage; giving it width:100% pins it to the stage's DEFINITE content box (the
   window width minus the stage margin) instead of shrink-wrapping to the pill's narrow content — otherwise
   the pill floated centered as a microsquare (measured: a 295px bar of naked buttons in a 708px window). */
.pill-mount{width:100%}
/* With a definite-width mount, .pill-app then takes the same fluid-panel invariant every surface inherits
   from .hud (styles.ts): width:100% up to the 660px cap, min-width:0 so its flex children can shrink. */
.pill-app{display:flex;flex-direction:column;gap:0;width:100%;max-width:660px;min-width:0}
/* the header RECTANGLE — always visible, the compact bar the panel docks beneath. It carries the SAME
   glass-card idiom as .hud (styles.ts:41 — the shared --s-glass fill, backdrop blur, hairline border and
   floating shadow) so the collapsed pill reads as one solid glass card, never as naked floating buttons. */
.pill-bar{display:flex;align-items:center;gap:12px;padding:8px 12px;min-height:40px;
  background:var(--s-glass);backdrop-filter:blur(20px);border:1px solid var(--s-line);border-radius:15px;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.07), 0 34px 70px -24px rgba(0,0,0,.8);
  -webkit-app-region:drag}
.pill-bar button{-webkit-app-region:no-drag}
.pill-brand{display:flex;align-items:center;gap:7px;min-width:0}
.pill-dot{width:8px;height:8px;border-radius:50%;background:var(--accent);flex:none}
.pill-name{font-size:12px;font-weight:600;letter-spacing:-.01em;color:var(--s-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pill-faces{display:flex;gap:4px;margin-left:auto}
.pill-face-btn{font:inherit;font-size:11px;font-weight:600;letter-spacing:.01em;color:var(--s-muted);
  background:transparent;border:1px solid var(--s-line);border-radius:8px;padding:4px 12px;cursor:pointer;white-space:nowrap}
.pill-face-btn:hover:not([disabled]){color:var(--s-ink);border-color:var(--accent)}
.pill-face-btn.active{color:var(--s-ink);background:rgba(255,255,255,.06);border-color:var(--accent)}
.pill-face-btn[disabled]{opacity:.45;cursor:default}
.pill-tools{display:flex;align-items:center;gap:4px}
.pill-toggle{font:inherit;font-size:10.5px;font-weight:600;color:var(--s-muted);background:transparent;
  border:1px solid var(--s-line);border-radius:8px;padding:4px 10px;cursor:pointer}
.pill-toggle:hover{color:var(--s-ink);border-color:var(--accent)}
/* settings-on-hover: a hover-revealed gear that opens the existing settings path (never a new settings UI) */
.pill-settings{font-size:13px;line-height:1;color:var(--s-faint);background:transparent;border:0;padding:2px 4px;
  cursor:pointer;opacity:0;transition:opacity .15s ease}
.pill-bar:hover .pill-settings,.pill-settings:focus{opacity:1}
.pill-settings:hover{color:var(--s-ink)}
/* the docked panel beneath the bar — its height is owned by the PillController (bar/listen/ask extents) */
.pill-panel{flex:1;min-height:0;overflow-y:auto}
.pill-panel .hud{padding:8px 4px}
.pill-collapsed{display:none}
/* honest face note (Ask unresolved/absent) — visible text, never a blank panel */
.pill-face-note{font-size:12px;color:var(--s-muted);padding:14px 16px;line-height:1.5}
/* the #58 live-transcript strip the Hud appends: only meaningful on the Listen face; hidden on Ask */
.pill-app[data-face="ask"] .lt{display:none}
.pill-app[data-open="false"] .lt{display:none}
`
