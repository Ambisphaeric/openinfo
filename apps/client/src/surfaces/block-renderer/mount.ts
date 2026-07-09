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
 * Paint the copy outcome onto the clicked button: flip its label to "Copied" / "Copy failed" and add a
 * `copied` / `copyfail` class (styled in hud/styles.ts), then revert after a beat. Driven by the actual
 * promise outcome — a rejected write shows failure, never a silent no-op. A live re-render (renderInto)
 * simply repaints the button, discarding a still-pending transient state, which is the desired reset.
 */
const paintCopyFeedback = (el: ActionElement, outcome: void | Promise<void>): void => {
  const originalLabel = el.textContent
  const originalClass = el.className
  const settle = (ok: boolean): void => {
    el.textContent = ok ? 'Copied' : 'Copy failed'
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
 * not the buttons). Only the `copy` verb is live — it calls the injected `copy` and paints the copy
 * outcome onto the clicked button; every other verb is visible-but-inert this slice (dismiss/mark-done/
 * draft-with have no write path yet — PHASE2-NOTES). Call once at mount; re-render with renderInto
 * without re-wiring.
 */
export const wireActions = (target: MountTarget, copy: CopyFn): void => {
  target.addEventListener('click', (event) => {
    const el = event.target?.closest('[data-verb]')
    if (!el) return
    if (el.getAttribute('data-verb') !== 'copy') return
    paintCopyFeedback(el, copy(el.getAttribute('data-copy') ?? ''))
  })
}

/** Initial mount: render + wire the (single) action listener. */
export const mountSurface = (target: MountTarget, node: VNode, opts: { copy: CopyFn }): void => {
  renderInto(target, node)
  wireActions(target, opts.copy)
}
