import { h, type VNode } from '../block-renderer/vnode.js'
import type { BlockRenderArgs, SessionReadiness } from '../block-renderer/registry.js'

export type { SessionReadiness }

/**
 * The IN-WINDOW session control (#136) — the on-surface start/stop affordance the owner asked for (the
 * note-taker's Record button was a disabled placeholder disclosing "controlled from the tray"; the menu-bar
 * round-trip was the friction). It dispatches through the SAME shell session path the tray uses — verb
 * `session-start` / `session-stop` → the mount layer's injected handler → the shell's `start-session` /
 * `end-session` command (dev-entry → the openinfoSession bridge → shell.ts dispatch) — so there is ONE
 * session lifecycle and the #41 consent boundary is untouched: a session NEVER auto-starts, capture ON is an
 * explicit user act each time (the click), and the client still boots STOPPED (this renders from live=false).
 *
 * HONESTY (the interaction lint + hud-voice): the button is LIVE only when the action can actually succeed.
 * `SessionReadiness` is the can-this-act signal the shell feeds down from the SAME state the tray reads
 * (main-process engine/capture state). When NOT ready — no shell bridge (a plain browser can neither consent
 * to nor run capture), the engine is unreachable, or an engine was skew-refused — the control renders DISABLED
 * with the TRUE reason inline (never a fake-live button, never a tooltip-only disclosure). Mic-blocked / a
 * capture fault do NOT disable start/stop (the session + text path still works, exactly as the tray allows) —
 * they surface as an honest capture NOTE while live, mirroring the tray's `● rec` / `mic blocked` status line.
 */

/** The reason shown when there is no shell bridge at all (a plain browser / served frame test). */
export const NO_BRIDGE_REASON = 'Recording is controlled from the desktop app'

/**
 * Render the session control. `live` is the engine truth (a session is live) — the SAME `NowContext.live`
 * the `now` block reads, so start↔stop flips with the real session state. `readiness` is the shell's
 * can-this-act signal (absent ⇒ disabled with the desktop-app reason). Returns the `.session-control` group:
 * a single button (Record when stopped, Stop when live — one control does both jobs, like the tray toggle)
 * plus, while live, an honest capture note. Never a silent dead button — the disabled branch carries the
 * `disabled` attribute + inline reason, the live branch a wired `session-start` / `session-stop` verb.
 */
export const renderSessionControl = (input: { live: boolean; readiness?: SessionReadiness }): VNode => {
  const readiness = input.readiness
  const ready = readiness?.ready ?? false
  if (!ready) {
    const reason = readiness?.reason ?? NO_BRIDGE_REASON
    return h(
      'div',
      { class: 'session-control' },
      h(
        'button',
        { class: 'session-record pending', 'data-nt': 'record', disabled: true, title: reason },
        h('span', { class: 'session-record-dot' }),
        'Record',
      ),
      h('span', { class: 'session-record-note' }, reason),
    )
  }
  const verb = input.live ? 'session-stop' : 'session-start'
  const label = input.live ? 'Stop' : 'Record'
  const cls = input.live ? 'session-record recording' : 'session-record'
  const children: VNode[] = [
    h('button', { class: cls, 'data-nt': 'record', 'data-verb': verb }, h('span', { class: 'session-record-dot' }), label),
  ]
  if (input.live && readiness?.capture) {
    const noteClass = readiness.capture.tone === 'warn' ? 'session-record-note warn' : 'session-record-note'
    children.push(h('span', { class: noteClass }, readiness.capture.note))
  }
  return h('div', { class: 'session-control' }, ...children)
}

/**
 * The `session-control` BLOCK renderer (registered in the default registry) — the on-surface session control
 * as a document-composable block (#136), so any surface's stack (the HUD, an app window) can carry the same
 * start/stop affordance the note-taker's canvas header shows. Layout-only (no query): it reads the live state
 * from `now.live` and the can-this-act signal from the threaded `session` readiness, then delegates to the
 * SAME pure `renderSessionControl` the note-taker uses — one control, one behavior, one honest state.
 */
export const renderSessionControlBlock = (args: BlockRenderArgs): VNode =>
  renderSessionControl({ live: args.now.live, ...(args.session !== undefined ? { readiness: args.session } : {}) })

