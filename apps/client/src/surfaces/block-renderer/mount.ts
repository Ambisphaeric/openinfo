import { renderToHtml, type VNode } from './vnode.js'

/**
 * The imperative shell around the pure renderer. Typed structurally (a minimal DOM subset) rather
 * than pulling the DOM lib into this node-typed package — which would collide with @types/node's
 * fetch/WebSocket globals. The dev entry / Electron renderer casts a real element to MountTarget.
 */
export interface MountTarget {
  innerHTML: string
  addEventListener(type: 'click', handler: (event: MountClickEvent) => void): void
}
/**
 * The clicked action button, structurally typed. `getAttribute` reads the verb/payload; `textContent`
 * and `className` are mutated to paint transient copy feedback (see wireActions) — both are on every
 * real DOM Element, so a live browser button satisfies this without a cast.
 */
interface ActionElement {
  getAttribute(name: string): string | null
  textContent: string
  className: string
}
interface MountClickEvent {
  target: { closest(selector: string): ActionElement | null } | null
}

/**
 * Clipboard-safe copy abstraction — injected so it works in a browser, Electron, or a test. Its
 * outcome is HONEST: the returned promise resolves only on a confirmed write and rejects when every
 * copy path fails, so wireActions can drive visible success/failure feedback off it (#43). A plain
 * `void` return is treated as success (a legacy/synchronous injector).
 */
export type CopyFn = (text: string) => void | Promise<void>

/**
 * The write-path handlers the mount layer drives per verb (#15). Each is INJECTED (the pure renderer
 * never touches the network) and its promise outcome drives the SAME honest success/failure feedback
 * the copy verb pioneered (#43) — a resolved write paints success, a rejected one paints failure as
 * visible text on the clicked button, never a silent no-op. `copy` is required (the always-present
 * verb); `markDone`/`accept` are optional so a harness can wire only what it serves — a verb whose
 * handler is absent (or whose button carries no payload) stays visible-but-inert, exactly as the
 * unwired verbs (open/navigate/dismiss/run-mode/draft-with) do this slice.
 */
export interface ActionHandlers {
  copy: CopyFn
  /** mark a to-do item done → PUT /todos/:sessionId (read-flip-write). */
  markDone?: (payload: { sessionId: string; todoId: string }) => Promise<void>
  /** apply a suggested teach hint candidate → PUT /hints/:workspaceId (append the pattern). */
  accept?: (payload: { workspaceId: string; pattern: string }) => Promise<void>
  /** dismiss an item → POST /item-signals (a suppression record; queries then exclude it) — #66. */
  dismiss?: (payload: { workspaceId: string; source: string; itemId: string }) => Promise<void>
  /**
   * Answer the #75 clarify ask → POST /teach/entity (writes a labeled TeachSignal AND a sovereign
   * EntityOverride). The verdict is `confirm` (the mention is the linked candidate) or `disambiguate`
   * (it is the rival). Its promise outcome paints the SAME honest success/failure flip on the clicked
   * choice; a failed write surfaces as visible text, never a silent no-op.
   */
  clarify?: (payload: {
    workspaceId: string
    entityId: string
    heard: string
    verdict: 'confirm' | 'disambiguate'
    rivalId?: string
    rivalName?: string
  }) => Promise<void>
  /**
   * Open the #75 clarify ask for an entity — a client-local expand (NOT a write, so NOT through
   * paintFeedback): the Hud flips its session `expanded` id and re-renders, exactly like the #96 mute.
   */
  clarifyOpen?: (entityId: string) => void
  /**
   * Dismiss the #75 clarify ask ("ask me later") — client-local, teaches NOTHING: the Hud adds the entity
   * to its session `suppressed` set and re-renders, so it stays quiet this session (no write, no override).
   */
  clarifyDismiss?: (entityId: string) => void
  /**
   * Toggle the live strip's system-audio mute (#96) — a client-local DISPLAY filter, not a write path,
   * so it does NOT go through paintFeedback (there is no success/failure outcome to report): it flips a
   * bit of client state and the ensuing re-render reflects the new state on the button itself.
   */
  muteSystemStream?: () => void
  /**
   * Select the pill's face (Listen/Ask) — a client-local view toggle (the PillController flips state and
   * re-paints), not a write path, so no paintFeedback: the re-render reflects the new active face.
   */
  pillFace?: (face: 'listen' | 'ask') => void
  /** Show-Hide the pill's docked panel — client-local; collapses the panel to the bar and back. */
  pillToggle?: () => void
  /** Open the EXISTING settings path from the pill's settings-on-hover affordance (shell bridge). */
  pillSettings?: () => void
  /**
   * Start a session from an on-surface control (#136) — the SAME shell path the tray's Start Session uses
   * (dev-entry → the openinfoSession bridge → shell.ts `dispatch('start-session')`: capture consent granted
   * there, one lifecycle). NOT a paintFeedback write: the outcome (a session started, capture began, or a
   * fault) flows back as the live/capture state on the next render, exactly like the tray's label flip. A
   * build without the bridge leaves the control disabled, so this never fires there.
   */
  sessionStart?: () => void
  /** Stop the live session from an on-surface control (#136) — the SAME shell `end-session` path (revokes consent). */
  sessionStop?: () => void
}

/** Replace the target's content with a freshly rendered VNode (called on every live update). */
export const renderInto = (target: MountTarget, node: VNode): void => {
  target.innerHTML = renderToHtml(node)
}

/** How long the transient copy state (button text/class flip) stays up before reverting. */
const COPY_FEEDBACK_MS = 1200
const COPY_STATE_CLASSES = ['copied', 'copyfail']

const withoutStateClasses = (className: string): string =>
  className.split(/\s+/).filter((c) => c && !COPY_STATE_CLASSES.includes(c)).join(' ')

/** Fire a revert timer that will never hold a node process open (browser timers have no unref). */
const scheduleRevert = (fn: () => void): void => {
  const handle = setTimeout(fn, COPY_FEEDBACK_MS) as unknown as { unref?: () => void }
  handle.unref?.()
}

/**
 * Paint an action outcome onto the clicked button: flip its label to the success/failure word and add a
 * `copied` / `copyfail` class (styled in hud/styles.ts — reused for every verb, they are just the
 * green/red success/failure flip), then revert after a beat. Driven by the ACTUAL promise outcome — a
 * rejected write shows failure, never a silent no-op. A live re-render (renderInto) simply repaints the
 * button, discarding a still-pending transient state, which is the desired reset. Generalized from the
 * copy-only painter (#43) so mark-done/accept report their real write outcome the same honest way (#15).
 */
const paintFeedback = (el: ActionElement, outcome: void | Promise<void>, labels: { ok: string; fail: string }): void => {
  const originalLabel = el.textContent
  const originalClass = el.className
  const settle = (ok: boolean): void => {
    el.textContent = ok ? labels.ok : labels.fail
    el.className = `${withoutStateClasses(el.className)} ${ok ? 'copied' : 'copyfail'}`.trim()
    scheduleRevert(() => {
      el.textContent = originalLabel
      el.className = originalClass
    })
  }
  Promise.resolve(outcome).then(
    () => settle(true),
    () => settle(false),
  )
}

/**
 * The verbs this mount layer's delegated click listener actually dispatches — the SINGLE source of truth
 * for "a click on this verb does something here". It is consumed two ways so it can never drift from
 * reality: wireActions GATES on it (a `data-verb` not in this set is ignored before the branches below, so
 * a stray dispatch branch someone forgot to register here is inert and gets noticed), and the honesty
 * interaction lint IMPORTS it (unioned with input-submit's verb) instead of hand-maintaining a parallel
 * list. Keep it in lockstep with the branches in wireActions below — a verb this set claims but no branch
 * handles is a dead button the lint would wrongly bless. `input-submit` is NOT here: that verb is
 * dispatched by the input block's own controller (hud/input-submit.ts), which exports it separately.
 */
export const WIRED_VERBS: ReadonlySet<string> = new Set([
  'copy',
  'mark-done',
  'accept',
  'dismiss',
  'clarify-confirm',
  'clarify-rival',
  'clarify-open',
  'clarify-dismiss',
  'mute-system-stream',
  'pill-face',
  'pill-toggle',
  'pill-settings',
  'session-start',
  'session-stop',
])

/**
 * Attach ONE delegated click listener that survives innerHTML replacement (it lives on the container,
 * not the buttons). Live verbs call their injected handler and paint the ACTUAL outcome onto the clicked
 * button (#43/#15): `copy` → the CopyFn; `mark-done` → `markDone` (needs data-session + data-todo);
 * `accept` → `accept` (needs data-workspace + data-pattern). A verb whose handler is not injected, or
 * whose button carries no payload, is left untouched — visible-but-inert, like the still-unwired verbs
 * (open/navigate/dismiss/run-mode/draft-with — no write path this slice; see PHASE4-NOTES). Call once at
 * mount; re-render with renderInto without re-wiring.
 */
export const wireActions = (target: MountTarget, handlers: ActionHandlers): void => {
  target.addEventListener('click', (event) => {
    const el = event.target?.closest('[data-verb]')
    if (!el) return
    const verb = el.getAttribute('data-verb')
    // Gate on the source-of-truth set: a verb this layer does not claim is ignored here, so WIRED_VERBS
    // stays honest about exactly which verbs reach a dispatch branch below.
    if (verb === null || !WIRED_VERBS.has(verb)) return
    if (verb === 'copy') {
      paintFeedback(el, handlers.copy(el.getAttribute('data-copy') ?? ''), { ok: 'Copied', fail: 'Copy failed' })
      return
    }
    if (verb === 'mark-done' && handlers.markDone) {
      const sessionId = el.getAttribute('data-session')
      const todoId = el.getAttribute('data-todo')
      if (sessionId === null || todoId === null) return // inert button — no addressable to-do
      paintFeedback(el, handlers.markDone({ sessionId, todoId }), { ok: 'Done', fail: 'Failed' })
      return
    }
    if (verb === 'accept' && handlers.accept) {
      const workspaceId = el.getAttribute('data-workspace')
      const pattern = el.getAttribute('data-pattern')
      if (workspaceId === null || pattern === null) return // inert button — no candidate to apply
      paintFeedback(el, handlers.accept({ workspaceId, pattern }), { ok: 'Accepted', fail: 'Failed' })
      return
    }
    if (verb === 'dismiss' && handlers.dismiss) {
      const workspaceId = el.getAttribute('data-workspace')
      const source = el.getAttribute('data-source')
      const itemId = el.getAttribute('data-item')
      if (workspaceId === null || source === null || itemId === null) return // inert glyph — no addressable item
      paintFeedback(el, handlers.dismiss({ workspaceId, source, itemId }), { ok: '✓', fail: '!' })
      return
    }
    if ((verb === 'clarify-confirm' || verb === 'clarify-rival') && handlers.clarify) {
      const workspaceId = el.getAttribute('data-workspace')
      const entityId = el.getAttribute('data-entity')
      const heard = el.getAttribute('data-heard')
      if (workspaceId === null || entityId === null || heard === null) return // inert — nothing addressable
      const rivalId = el.getAttribute('data-rival-id')
      const rivalName = el.getAttribute('data-rival-name')
      const verdict = verb === 'clarify-confirm' ? 'confirm' : 'disambiguate'
      paintFeedback(
        el,
        handlers.clarify({
          workspaceId,
          entityId,
          heard,
          verdict,
          ...(rivalId !== null ? { rivalId } : {}),
          ...(rivalName !== null ? { rivalName } : {}),
        }),
        { ok: '✓', fail: '!' },
      )
      return
    }
    if (verb === 'clarify-open' && handlers.clarifyOpen) {
      // A client-local expand (no write) — the Hud flips its session `expanded` id and re-renders.
      const entityId = el.getAttribute('data-entity')
      if (entityId !== null) handlers.clarifyOpen(entityId)
      return
    }
    if (verb === 'clarify-dismiss' && handlers.clarifyDismiss) {
      // "Ask me later" — client-local, teaches nothing. The Hud suppresses the entity this session.
      const entityId = el.getAttribute('data-entity')
      if (entityId !== null) handlers.clarifyDismiss(entityId)
      return
    }
    if (verb === 'mute-system-stream' && handlers.muteSystemStream) {
      // #96: a client-local display toggle, not a write. No paintFeedback — the re-render it triggers
      // repaints the button in its new state (label flips hide↔show), which IS the feedback.
      handlers.muteSystemStream()
      return
    }
    if (verb === 'pill-face' && handlers.pillFace) {
      // The pill's Listen/Ask mode toggle — client-local view state (PillController), no write. The
      // re-render reflects the new active face; an unrecognized data-face is ignored.
      const face = el.getAttribute('data-face')
      if (face === 'listen' || face === 'ask') handlers.pillFace(face)
      return
    }
    if (verb === 'pill-toggle' && handlers.pillToggle) {
      // Show-Hide: collapse the pill's docked panel to the bar and back. Client-local; no paintFeedback.
      handlers.pillToggle()
      return
    }
    if (verb === 'pill-settings' && handlers.pillSettings) {
      // Settings-on-hover: open the EXISTING settings path over the shell bridge. Not a paintFeedback
      // write — a fire-and-forget open handled in main; a missing bridge is an honest no-op there.
      handlers.pillSettings()
      return
    }
    if (verb === 'session-start' && handlers.sessionStart) {
      // #136 in-window start: dispatch through the SAME shell session path the tray uses (consent granted
      // in main). Not paintFeedback — the session.started event + readiness snapshot re-render the control
      // into its live/capture state, exactly like the tray's label flip. The button is disabled when it
      // cannot act, so a live click always has a real dispatch behind it.
      handlers.sessionStart()
      return
    }
    if (verb === 'session-stop' && handlers.sessionStop) {
      // #136 in-window stop: the SAME shell end-session path (revokes consent so nothing auto-resumes).
      handlers.sessionStop()
      return
    }
    // Reached by a WIRED_VERBS verb whose handler was not injected, or whose button carries no payload:
    // left untouched — visible-but-inert. Verbs outside WIRED_VERBS (pin, mark-for-follow-up, open,
    // navigate, run-mode, draft-with) never get here — the gate above already ignored them (see
    // PHASE4-NOTES / #15: no write path yet).
  })
}

/** Initial mount: render + wire the delegated action listener. */
export const mountSurface = (target: MountTarget, node: VNode, handlers: ActionHandlers): void => {
  renderInto(target, node)
  wireActions(target, handlers)
}
