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
interface MountClickEvent {
  target: { closest(selector: string): { getAttribute(name: string): string | null } | null } | null
}

/** Clipboard-safe copy abstraction — injected so it works in a browser, Electron, or a test. */
export type CopyFn = (text: string) => void | Promise<void>

/** Replace the target's content with a freshly rendered VNode (called on every live update). */
export const renderInto = (target: MountTarget, node: VNode): void => {
  target.innerHTML = renderToHtml(node)
}

/**
 * Attach ONE delegated click listener that survives innerHTML replacement (it lives on the container,
 * not the buttons). Only the `copy` verb is live — it calls the injected `copy`; every other verb is
 * visible-but-inert this slice (dismiss/mark-done/draft-with have no write path yet — PHASE2-NOTES).
 * Call once at mount; re-render with renderInto without re-wiring.
 */
export const wireActions = (target: MountTarget, copy: CopyFn): void => {
  target.addEventListener('click', (event) => {
    const el = event.target?.closest('[data-verb]')
    if (!el) return
    if (el.getAttribute('data-verb') === 'copy') void copy(el.getAttribute('data-copy') ?? '')
  })
}

/** Initial mount: render + wire the (single) action listener. */
export const mountSurface = (target: MountTarget, node: VNode, opts: { copy: CopyFn }): void => {
  renderInto(target, node)
  wireActions(target, opts.copy)
}
