import type { BlockQuery, QueryResult, Session, Surface } from '@openinfo/contracts'
import { mountSurface, renderInto, type MountTarget } from '../block-renderer/index.js'
import { Hud } from './hud.js'
import { createBootController } from './boot.js'
import type { HudTransport } from './transport.js'
import { hudStyles, hudOutlineStyles } from './styles.js'
import { installWindowDrag, type DragBridge } from './window-drag.js'

/**
 * A plain-browser dev entry that renders the live HUD against a running engine — the mountable view
 * plus its shell. Phase 1 left NO Electron window (PHASE1-NOTES: the seam was proven headless), so the
 * HUD mounts here today; wiring it into a real content-protected Electron window is the small follow-up
 * (client/main is still a Phase-1 scaffold). Serve apps/client over a static server and open
 *   dev-hud.html?engine=http://127.0.0.1:8787
 * with the engine running. Uses a fetch-based transport (NOT EngineLink, which pulls node:fs for its
 * capture spool); Electron will pass an EngineLink, which satisfies HudTransport structurally.
 */

/** A fetch + WebSocket transport — browser-safe, unlike EngineLink. */
class BrowserTransport implements HudTransport {
  constructor(private readonly baseUrl: string) {}

  async surface(id: string): Promise<Surface> {
    return this.getJson(`/layouts/surfaces/${encodeURIComponent(id)}`) as Promise<Surface>
  }

  async query(query: BlockQuery): Promise<QueryResult> {
    const response = await fetch(`${this.baseUrl}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(query),
    })
    return (await response.json()) as QueryResult
  }

  async sessions(opts: { workspace?: string; live?: boolean }): Promise<Session[]> {
    const params = new URLSearchParams()
    if (opts.workspace !== undefined) params.set('workspace', opts.workspace)
    if (opts.live) params.set('live', 'true')
    const suffix = params.toString()
    return this.getJson(`/sessions${suffix ? `?${suffix}` : ''}`) as Promise<Session[]>
  }

  subscribe(handler: (event: { name: string; payload: unknown }) => void): () => void {
    // RECONNECTING socket: the engine may not be up yet (boot race) or may restart mid-session; a
    // one-shot socket left the HUD deaf forever. On every (re)open we synthesize 'ws.open' so the Hud
    // re-hydrates data missed while disconnected (hud.ts REFRESH_EVENTS). Unsubscribe stops the loop.
    let socket: WebSocket | undefined
    let closed = false
    let retryMs = 1_000
    const connect = (): void => {
      if (closed) return
      socket = new WebSocket(`${this.baseUrl.replace(/^http/, 'ws')}/events`)
      socket.addEventListener('open', () => {
        retryMs = 1_000
        handler({ name: 'ws.open', payload: undefined })
      })
      socket.addEventListener('message', (event) => {
        try {
          const parsed = JSON.parse(String((event as { data: unknown }).data)) as { name?: unknown; payload?: unknown }
          if (typeof parsed.name === 'string') handler({ name: parsed.name, payload: parsed.payload })
        } catch {
          /* ignore malformed frames */
        }
      })
      socket.addEventListener('close', () => {
        if (closed) return
        setTimeout(connect, retryMs)
        retryMs = Math.min(retryMs * 2, 10_000)
      })
    }
    connect()
    return () => {
      closed = true
      socket?.close()
    }
  }

  private async getJson(path: string): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`)
    return response.json()
  }
}

// --- browser shell, typed structurally (no DOM lib; keeps @types/node globals conflict-free) ---
interface DevElement extends MountTarget {
  id: string
  className: string
  textContent: string
  appendChild(child: DevElement): void
}
interface DevGlobal {
  document?: {
    readyState: string
    head: DevElement
    body: DevElement
    createElement(tag: string): DevElement
    addEventListener(type: string, listener: () => void): void
  }
  location?: { search: string }
  navigator?: { clipboard?: { writeText(text: string): Promise<void> } }
  /** Present only inside the Electron shell (preload.ts) — absent in a plain browser. */
  openinfoDrag?: DragBridge
}

const clipboardCopy =
  (nav?: DevGlobal['navigator']) =>
  (text: string): void => {
    void nav?.clipboard?.writeText(text)
  }

export const startHud = (options: { baseUrl?: string; workspace?: string; surfaceId?: string } = {}): void => {
  const g = globalThis as unknown as DevGlobal
  const doc = g.document
  if (!doc) return
  const params = new URLSearchParams(g.location?.search ?? '')
  const engineParam = params.get('engine')
  const baseUrl = options.baseUrl ?? engineParam ?? 'http://127.0.0.1:8787'
  // Which surface the HUD renders: explicit option wins, else ?surface= from the URL, else the default
  // (the Electron shell passes ?surface from ShellConfig.surfaceId; the browser dev harness accepts it too).
  const resolvedSurfaceId = options.surfaceId ?? params.get('surface') ?? undefined

  const style = doc.createElement('style')
  style.textContent = hudStyles
  // Debug outline (?outline=1, from OPENINFO_HUD_OUTLINE / client.json hudOutline): the window is
  // frameless + transparent, so when nothing paints there is NOTHING to see. The outline draws the
  // window bounds + the panel bounds so "where does the HUD render" is answerable by looking.
  if (params.get('outline')) style.textContent += hudOutlineStyles
  doc.head.appendChild(style)
  const stage = doc.createElement('div')
  stage.className = 'stage'
  // The boot-status chip: every boot/runtime failure paints here as text (a transparent window must
  // never fail invisibly — the same honesty rule the settings save strip follows). Empty when healthy.
  const status = doc.createElement('div')
  status.className = 'hud-boot-status'
  const panel = doc.createElement('div')
  stage.appendChild(status)
  stage.appendChild(panel)
  doc.body.appendChild(stage)

  // In the Electron shell only: let the header strip drag the frameless window (preload.ts bridge).
  if (g.openinfoDrag) installWindowDrag(doc as unknown as Parameters<typeof installWindowDrag>[0], g.openinfoDrag)

  const copy = clipboardCopy(g.navigator)
  let mounted = false
  // Event-driven refresh failures re-enter the boot loop — visible, never an unhandled rejection.
  let onHudError: (error: unknown) => void = () => {}
  const hud = new Hud({
    transport: new BrowserTransport(baseUrl),
    ...(options.workspace !== undefined ? { workspace: options.workspace } : {}),
    ...(resolvedSurfaceId !== undefined ? { surfaceId: resolvedSurfaceId } : {}),
    onRender: (node) => {
      if (!mounted) {
        mountSurface(panel, node, { copy })
        mounted = true
      } else {
        renderInto(panel, node)
      }
    },
    onError: (error) => onHudError(error),
  })
  // Boot through the retry controller, NOT `void hud.start()`: the packaged shell creates this window
  // BEFORE its bundled engine finishes spawning, so the first fetch typically loses that race. The old
  // one-shot swallowed the rejection — a permanently blank transparent window (the invisible-HUD bug).
  // The controller retries with capped backoff forever and paints its state into the status chip.
  const boot = createBootController({
    start: () => hud.start(),
    stop: () => hud.stop(),
    onStatus: (text) => {
      status.textContent = text ?? ''
    },
    engineLabel: baseUrl,
  })
  onHudError = (error) => boot.restart(error)
  boot.boot()
}

// Auto-start when loaded as a module in a browser document.
{
  const g = globalThis as unknown as DevGlobal
  if (g.document) {
    if (g.document.readyState === 'loading') g.document.addEventListener('DOMContentLoaded', () => startHud())
    else startHud()
  }
}
