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
    // every other verb is visible-but-inert this slice (no write path yet)
  })
}

/** Initial mount: render + wire the delegated action listener. */
export const mountSurface = (target: MountTarget, node: VNode, handlers: ActionHandlers): void => {
  renderInto(target, node)
  wireActions(target, handlers)
}
