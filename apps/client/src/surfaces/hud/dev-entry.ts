import type { AttributionPattern, BlockQuery, QueryResult, Session, Surface, TodoList, WorkspaceHints } from '@openinfo/contracts'
import { mountSurface, renderInto, type MountTarget } from '../block-renderer/index.js'
import { Hud } from './hud.js'
import { createBootController } from './boot.js'
import type { HudTransport } from './transport.js'
import { hudStyles, hudOutlineStyles } from './styles.js'
import { installWindowDrag, type DragBridge } from './window-drag.js'
import { installAutoResize, type ResizeBridge } from './auto-resize.js'

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
  // The execCommand copy fallback drives a throwaway <textarea>; these live on every real DOM element.
  value?: string
  select?(): void
  remove?(): void
}
interface DevGlobal {
  document?: {
    readyState: string
    head: DevElement
    body: DevElement
    createElement(tag: string): DevElement
    addEventListener(type: string, listener: () => void): void
    // Legacy synchronous copy path — present in every renderer, absent in a bare node test.
    execCommand?(command: string): boolean
  }
  location?: { search: string }
  navigator?: { clipboard?: { writeText(text: string): Promise<void> } }
  /** Present only inside the Electron shell (preload.cts) — absent in a plain browser. */
  openinfoDrag?: DragBridge & ResizeBridge
}

/**
 * The temp-<textarea> + `document.execCommand('copy')` fallback. Used when the async Clipboard API is
 * unavailable (insecure context / no renderer permission) or rejects. Synchronous — append, select,
 * copy, remove all in one tick, so the throwaway textarea never repaints. Returns the honest boolean.
 */
const execCommandCopy = (doc: DevGlobal['document'] | undefined, text: string): boolean => {
  if (!doc?.execCommand) return false
  const area = doc.createElement('textarea')
  area.value = text
  doc.body.appendChild(area)
  area.select?.()
  let ok = false
  try {
    ok = doc.execCommand('copy')
  } catch {
    ok = false
  } finally {
    area.remove?.()
  }
  return ok
}

/**
 * Honest clipboard copy (#43): try the async Clipboard API, fall back to the execCommand path when it
 * is absent OR rejects, and resolve only on a confirmed write — otherwise REJECT. The old body
 * `void nav?.clipboard?.writeText(text)` swallowed a missing API and discarded a rejected promise, so a
 * failed copy was indistinguishable from a dead button. The caller (wireActions) paints visible
 * success/failure feedback off this outcome, so there is no longer a silent path.
 */
export const clipboardCopy =
  (nav?: DevGlobal['navigator'], doc?: DevGlobal['document']) =>
  async (text: string): Promise<void> => {
    if (nav?.clipboard?.writeText) {
      try {
        await nav.clipboard.writeText(text)
        return
      } catch {
        /* fall through to the execCommand fallback */
      }
    }
    if (execCommandCopy(doc, text)) return
    throw new Error('copy failed: no clipboard path available')
  }

/** Injectable fetch so the served e2e can drive these against a live throwaway server (default: global). */
type FetchLike = typeof fetch

/**
 * The `mark-done` write path (#15): read the session's to-do document, flip the addressed item's `done`,
 * and PUT the whole edited list back (PUT /todos/:sessionId takes the full TodoList — read-flip-write, so
 * the store stamps the next version and keeps history). The outcome is HONEST: a non-ok GET or PUT REJECTS
 * with the HTTP status, so the mount layer paints visible failure text rather than a silent no-op (#43).
 */
export const markTodoDone =
  (baseUrl: string, fetchFn: FetchLike = fetch) =>
  async ({ sessionId, todoId }: { sessionId: string; todoId: string }): Promise<void> => {
    const url = `${baseUrl}/todos/${encodeURIComponent(sessionId)}`
    const current = await fetchFn(url)
    if (!current.ok) throw new Error(`mark-done: could not load the to-do list (HTTP ${current.status})`)
    const list = (await current.json()) as TodoList
    const items = list.items.map((item) => (item.id === todoId ? { ...item, done: true } : item))
    const res = await fetchFn(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...list, items }),
    })
    if (!res.ok) throw new Error(`mark-done: write failed (HTTP ${res.status})`)
  }

/**
 * The `accept` write path (#15) — the APPLY half of the teach loop. The user reviews a SUGGESTED hint
 * candidate and accepts it: read the workspace's hints document (an unknown workspace has none yet → 404
 * → start a fresh empty doc, mirroring the engine's PUT-creates policy), append the candidate's pattern
 * (idempotent — a pattern already present is not duplicated), and PUT it back. Honest outcome: a real
 * load error (non-404) or a failed write REJECTS, so the click paints visible failure text.
 */
export const acceptHintCandidate =
  (baseUrl: string, fetchFn: FetchLike = fetch) =>
  async ({ workspaceId, pattern }: { workspaceId: string; pattern: string }): Promise<void> => {
    const parsed = JSON.parse(pattern) as AttributionPattern
    const url = `${baseUrl}/hints/${encodeURIComponent(workspaceId)}`
    const current = await fetchFn(url)
    let doc: WorkspaceHints
    if (current.ok) doc = (await current.json()) as WorkspaceHints
    else if (current.status === 404) doc = { workspaceId, patterns: [] }
    else throw new Error(`accept: could not load hints (HTTP ${current.status})`)
    const has = doc.patterns.some((p) => JSON.stringify(p) === JSON.stringify(parsed))
    const patterns = has ? doc.patterns : [...doc.patterns, parsed]
    const res = await fetchFn(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...doc, workspaceId, patterns }),
    })
    if (!res.ok) throw new Error(`accept: write failed (HTTP ${res.status})`)
  }

/**
 * The `dismiss` write path (#66) — the honest end of a verb that was visible-but-inert. Dismissing a row
 * POSTs a suppression record (an ItemSignal, kind `dismiss`) naming the item's source + id within its
 * workspace; the engine's POST /query then EXCLUDES it, so it stays dismissed across reloads. `at` is
 * server-stamped, so the body carries only workspace/source/item. Honest outcome: a non-ok POST REJECTS
 * with the HTTP status, so the clicked glyph paints visible failure rather than a silent no-op (#43).
 */
export const dismissItem =
  (baseUrl: string, fetchFn: FetchLike = fetch) =>
  async ({ workspaceId, source, itemId }: { workspaceId: string; source: string; itemId: string }): Promise<void> => {
    const res = await fetchFn(`${baseUrl}/item-signals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId, source, itemId, kind: 'dismiss' }),
    })
    if (!res.ok) throw new Error(`dismiss: write failed (HTTP ${res.status})`)
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

  // In the Electron shell only: let the header strip drag the frameless window (preload.cts bridge)…
  if (g.openinfoDrag) installWindowDrag(doc as unknown as Parameters<typeof installWindowDrag>[0], g.openinfoDrag)
  // …and content-size the frameless window to the painted panel (never the 100vh stage — see auto-resize.ts).
  if (g.openinfoDrag) installAutoResize(panel as unknown as Parameters<typeof installAutoResize>[0], g.openinfoDrag)

  const copy = clipboardCopy(g.navigator, doc)
  // The verb write-paths (#15): both read-then-write against the live engine and reject on any HTTP
  // failure, so the mount layer paints visible success/failure text on the clicked button (never silent).
  const markDone = markTodoDone(baseUrl)
  const accept = acceptHintCandidate(baseUrl)
  const dismiss = dismissItem(baseUrl)
  let mounted = false
  // Event-driven refresh failures re-enter the boot loop — visible, never an unhandled rejection.
  let onHudError: (error: unknown) => void = () => {}
  const hud = new Hud({
    transport: new BrowserTransport(baseUrl),
    ...(options.workspace !== undefined ? { workspace: options.workspace } : {}),
    ...(resolvedSurfaceId !== undefined ? { surfaceId: resolvedSurfaceId } : {}),
    onRender: (node) => {
      if (!mounted) {
        mountSurface(panel, node, { copy, markDone, accept, dismiss })
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
