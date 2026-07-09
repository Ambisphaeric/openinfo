/**
 * Renderer-side wiring that makes the HUD window CONTENT-sized. The window is frameless + transparent,
 * so a fixed frame taller than the painted panel leaves a swath of invisible, click-blocking dead zone
 * below the bar (the "box too big" report). Nothing resizes the window on its own, so the renderer
 * measures the painted panel and reports its height over the preload bridge; the main process sets the
 * window's content height to match (hud:resize → shell.ts → setContentSize). Growth is top-anchored:
 * the origin stays put and the window grows/shrinks downward.
 *
 * Pure over an injected element + bridge (+ an injectable rAF) so the measure/dedupe/coalesce logic is
 * asserted headless, exactly like window-drag.ts. In a plain browser (dev-hud.html) there is no bridge,
 * so dev-entry.ts simply doesn't install this — the browser HUD is a normal scrollable page.
 *
 * WHAT WE MEASURE: the panel wrapper (the element wrapping the painted `.hud`), NOT body/html/.stage's
 * base 100vh — measuring anything that can be viewport-tall makes the measurement self-fulfilling (the
 * window would only ever grow). hud.html's `min-height:0 !important` on `.stage` is what keeps the panel
 * honestly content-sized; we add back the stage's vertical padding so the reported height is the exact
 * content height the window should adopt.
 */

/** The stage's vertical padding in hud.html (`padding: 12px` → 12 top + 12 bottom). */
export const STAGE_VERTICAL_PADDING = 24

/** The tiny surface the preload exposes for resize (contextBridge → window.openinfoDrag.resize). */
export interface ResizeBridge {
  resize(height: number): void
}

interface MeasurableElement {
  getBoundingClientRect(): { height: number }
}

/** The bits of ResizeObserver + rAF we depend on — injectable so the wiring runs under node:test. */
interface ResizeObserverLike {
  observe(target: unknown): void
  disconnect(): void
}
interface AutoResizeWindow {
  ResizeObserver: new (callback: () => void) => ResizeObserverLike
  requestAnimationFrame: (cb: () => void) => number
}

/**
 * Observe `el` and report `ceil(height) + stage padding` over the bridge whenever it CHANGES — coalesced
 * to one report per animation frame (a burst of layout changes reports once), deduped so an unchanged
 * height never churns the window. Reports once immediately (the initial paint). Returns a disposer that
 * stops the observer. `win` defaults to globalThis (the renderer's window); tests inject a fake.
 */
export const installAutoResize = (
  el: MeasurableElement,
  bridge: ResizeBridge,
  win: AutoResizeWindow = globalThis as unknown as AutoResizeWindow,
): (() => void) => {
  let last = -1
  let scheduled = false

  const measure = (): number => Math.ceil(el.getBoundingClientRect().height) + STAGE_VERTICAL_PADDING

  const report = (): void => {
    const height = measure()
    if (height === last) return
    last = height
    bridge.resize(height)
  }

  const schedule = (): void => {
    if (scheduled) return
    scheduled = true
    win.requestAnimationFrame(() => {
      scheduled = false
      report()
    })
  }

  const observer = new win.ResizeObserver(schedule)
  observer.observe(el)
  report() // initial paint — don't wait for the first size change

  return () => observer.disconnect()
}
