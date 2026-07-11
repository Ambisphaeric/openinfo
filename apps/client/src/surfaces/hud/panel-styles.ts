/**
 * Styles for the #134 primitives — the `input` block and the attached-panel regions. Kept SEPARATE from the
 * main hudStyles string (design/renderings is the source of truth for the HUD chrome; these are the new
 * primitives) and injected alongside it by dev-entry. Deliberately minimal: exact geometry, animation, and
 * the futuristic conversation styling are the frontends design session — this is the honest functional look.
 */
export const panelStyles = `
.input-block{display:flex;flex-direction:column;gap:8px;padding:12px 16px 14px}
.in-log{display:flex;flex-direction:column;gap:8px;max-height:280px;overflow-y:auto}
.in-log:empty{display:none}
.in-turn{display:flex;flex-direction:column;gap:2px}
.in-turn .in-who{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--s-faint)}
.in-turn.user .in-who{color:var(--accent)}
.in-turn .in-msg{white-space:pre-wrap}
.in-cites{font-size:11px;color:var(--s-muted);font-family:var(--s-mono)}
.in-context:empty{display:none}
.in-attached{font-size:12px;color:var(--s-muted);padding:6px 8px;border:1px solid var(--s-line-soft);border-radius:8px}
.in-row{display:flex;align-items:flex-end;gap:8px}
.in-text{flex:1;min-height:34px;max-height:120px;resize:vertical;color:var(--s-ink);
  background:rgba(255,255,255,.04);border:1px solid var(--s-line);border-radius:9px;padding:8px 10px;
  font:inherit;font-size:13px}
.in-text:focus{outline:none;border-color:var(--accent)}
.in-drop{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--s-muted);
  border:1px dashed var(--s-line);border-radius:9px;padding:8px 10px;cursor:pointer}
.in-file{display:none}
.in-submit{align-self:stretch}
.in-status:empty{display:none}
.in-note{font-size:11px;padding:2px 0}
.in-note.ok{color:var(--m-decide)}
.in-note.info{color:var(--s-muted)}
.in-note.error{color:var(--accent)}
/* the sidebar's dismissible suggestion banner — a hint, never a modal */
.panel-suggestion{display:flex;align-items:center;justify-content:space-between;gap:8px;
  font-size:11px;color:var(--s-muted);padding:6px 12px;border-bottom:1px solid var(--s-line-soft)}
.panel-suggestion button{font:inherit;font-size:11px;color:var(--s-ink);background:none;
  border:1px solid var(--s-line);border-radius:7px;padding:2px 8px;cursor:pointer}
`
