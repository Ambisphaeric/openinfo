/**
 * The multi-window app registry (#19) — the backbone of "mini apps in a folder". The shell used to hold
 * ONE `hudWindow` bound to a single scalar surface id; the product frame is instead N windows, each a
 * surface rendered as its own app (a diagnostics app beside the real HUD, the same template opened for
 * several repos). This is that registry: windows keyed by surface id, open/focus/close per surface.
 *
 * It is GENERIC over the window handle `W` and fully dependency-injected (create/focus/close/isAlive) so
 * the whole open-or-focus / close / bookkeeping logic is asserted headless under node:test with fake
 * windows — the electron `BrowserWindow` never enters this file (the same pure-core discipline as
 * tray-menu.ts and window-options.ts). The shell supplies the real electron ops and calls `retire` from
 * each window's `closed` event so a user-closed window leaves no orphan entry behind.
 *
 * The per-window BINDING is immutable, matching the substrate: a window is BORN bound to its surface
 * (the surface id is a URL query param frozen at creation — see shell.ts/hud.ts). Multi-window is a
 * registry of such windows, never a mutable re-binding of one window.
 */

export interface WindowRegistryOps<W> {
  /** Create a brand-new window bound to `surfaceId`. Called only when none is currently open for it. */
  create: (surfaceId: string) => W
  /** Bring an already-open window to the front (open-or-FOCUS). */
  focus: (window: W) => void
  /** Close a window (open-or-focus's inverse — the shell's `closed` handler then calls `retire`). */
  close: (window: W) => void
  /**
   * Is this window still a live handle? A window can be destroyed out from under us (crash, an OS close
   * that raced our `closed` handler); a stale entry must never be focused. Defaults to always-alive when
   * omitted (tests that never destroy handles).
   */
  isAlive?: (window: W) => boolean
}

export class WindowRegistry<W> {
  private readonly windows = new Map<string, W>()

  constructor(private readonly ops: WindowRegistryOps<W>) {}

  private alive(window: W): boolean {
    return this.ops.isAlive ? this.ops.isAlive(window) : true
  }

  /**
   * Open the surface's window, or focus it if it is already open (the Apps folder's primary verb). A
   * registered-but-dead handle (a window destroyed without `retire` having run) is treated as closed and
   * replaced. Returns the live window either way.
   */
  openOrFocus(surfaceId: string): W {
    const existing = this.windows.get(surfaceId)
    if (existing !== undefined && this.alive(existing)) {
      this.ops.focus(existing)
      return existing
    }
    if (existing !== undefined) this.windows.delete(surfaceId) // stale/dead — drop it before recreating
    const created = this.ops.create(surfaceId)
    this.windows.set(surfaceId, created)
    return created
  }

  /** Close the surface's window if open. The shell's `closed` handler calls `retire` to drop the entry. */
  close(surfaceId: string): void {
    const window = this.windows.get(surfaceId)
    if (window === undefined) return
    if (this.alive(window)) this.ops.close(window)
    // Do NOT delete here: `close` triggers the window's `closed` event → the shell calls `retire`, the one
    // place an entry is removed. Deleting here too would double-remove and could drop a re-opened window.
  }

  /**
   * Drop the registry entry for a window that has closed — called from the window's own `closed` event so
   * a user-closed window (frame button, OS) leaves no orphan. Idempotent. Guarded against a race where the
   * surface was already re-opened into a DIFFERENT handle: only retire when the stored handle matches.
   */
  retire(surfaceId: string, window?: W): void {
    if (window !== undefined && this.windows.get(surfaceId) !== window) return
    this.windows.delete(surfaceId)
  }

  /** Is a (live) window currently open for this surface? Drives the Apps folder's open marker. */
  isOpen(surfaceId: string): boolean {
    const window = this.windows.get(surfaceId)
    return window !== undefined && this.alive(window)
  }

  /** The surface ids with a live open window — the set the shell persists so they reopen next launch (#19). */
  openSurfaceIds(): string[] {
    return [...this.windows.entries()].filter(([, w]) => this.alive(w)).map(([id]) => id)
  }

  /** Every live window handle — for shell-wide teardown / broadcast. */
  windowsList(): W[] {
    return [...this.windows.values()].filter((w) => this.alive(w))
  }
}
