import type { AttributionPattern, BlockQuery, ChatReply, ChatTurn, Pin, QueryResult, Session, Surface, TodoList, WorkspaceHints } from '@openinfo/contracts'
import { mountSurface, renderInto, type MountTarget } from '../block-renderer/index.js'
import { Hud } from './hud.js'
import { createBootController } from './boot.js'
import type { HudTransport } from './transport.js'
import { hudStyles, hudOutlineStyles } from './styles.js'
import { renderNotetaker } from './notetaker-layout.js'
import { panelStyles } from './panel-styles.js'
import { installWindowDrag, type DragBridge } from './window-drag.js'
import { installAutoResize, type ResizeBridge } from './auto-resize.js'
import { PanelController, type PanelSize } from './panel.js'
import { InputSession, type AttachedDoc, type UploadFile } from './input-submit.js'

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
    // The document's own title — the window names ITSELF in-content (S4): the renderer drives this from the
    // loaded surface's live name, which the framed titlebar / app switcher then reflect (page-title-updated).
    title?: string
    createElement(tag: string): DevElement
    addEventListener(type: string, listener: () => void): void
    // Legacy synchronous copy path — present in every renderer, absent in a bare node test.
    execCommand?(command: string): boolean
  }
  location?: { search: string }
  navigator?: { clipboard?: { writeText(text: string): Promise<void> } }
  /** Present only inside the Electron shell (preload.cts) — absent in a plain browser. `panel` (#134) is
   * additive: the attached-panel bridge that reports a collapsed/expanded content size to the main process. */
  openinfoDrag?: DragBridge & ResizeBridge & { panel?: (size: PanelSize) => void }
  /** #134 panel control seam — exposed so a keyboard/affordance (and the e2e) can drive expand/collapse. */
  openinfoPanel?: {
    toggle(): void
    expand(): void
    collapse(): void
    dismissSuggestion(): void
    state(): { expanded: boolean; suggested: boolean }
  }
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

/**
 * The `clarify` write path (#75) — the answer to an ambiguous-entity ask. POSTs the user's verdict to
 * `POST /teach/entity`, which writes BOTH a labeled TeachSignal AND a sovereign EntityOverride server-side
 * (the durable resolver short-circuit; a rejection records rejectedRivalId so the same wrong rival is never
 * re-offered). The body carries only the human verdict + surface form + ids; `correctedAt`, the signal id,
 * and the override provenance are ALL engine-stamped. Honest outcome: a non-ok POST REJECTS with the HTTP
 * status, so the clicked choice paints visible failure rather than a silent no-op (#43).
 */
export const submitEntityCorrection =
  (baseUrl: string, fetchFn: FetchLike = fetch) =>
  async (payload: {
    workspaceId: string
    entityId: string
    heard: string
    verdict: 'confirm' | 'disambiguate'
    rivalId?: string
    rivalName?: string
  }): Promise<void> => {
    const res = await fetchFn(`${baseUrl}/teach/entity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) throw new Error(`clarify: write failed (HTTP ${res.status})`)
  }

/**
 * The `input` block's chat submit path (#134). POSTs the turn to the configured route (e.g. /chat) WITH the
 * attached pin id + prior turns, and returns the ChatReply. Honest failure: a non-ok response REJECTS with
 * the engine's `error` message (or the HTTP status), so the input block paints it as visible text — never a
 * silent no-op. `workspace` is omitted when undefined so the engine applies its own default.
 */
export const submitChat =
  (baseUrl: string, workspace: string | undefined, fetchFn: FetchLike = fetch) =>
  async (input: { target: string; route: string; message: string; pinId?: string; history: ChatTurn[] }): Promise<ChatReply> => {
    const body: Record<string, unknown> = { message: input.message, history: input.history }
    if (workspace !== undefined) body['workspace'] = workspace
    if (input.pinId !== undefined) body['pinId'] = input.pinId
    const res = await fetchFn(`${baseUrl}${input.route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const detail = (await res.json().catch(() => undefined)) as { error?: string } | undefined
      throw new Error(detail?.error ?? `chat failed (HTTP ${res.status})`)
    }
    return (await res.json()) as ChatReply
  }

/**
 * The `input` block's file-drop path (#134) — reuses the EXISTING pins/ingest substrate. A dropped/picked
 * file in the desktop shell carries its local `path` (Electron `File.path`); we create a Pin over that path
 * and run the engine's ingest lifecycle (fetch → page-anchored chunks), so the extract becomes citable chat
 * context. Honest failure: no local path (a plain browser) or a failed ingest (a v0-unsupported pdf) REJECTS
 * with the real reason — the input block paints it. `.pdf` is a NAMED ingest failure by the engine's v0 policy.
 */
export const uploadAndIngest =
  (baseUrl: string, workspace: string | undefined, fetchFn: FetchLike = fetch, newId: () => string = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`) =>
  async (file: UploadFile): Promise<AttachedDoc> => {
    if (!file.path) throw new Error('file upload needs the desktop app (this file has no local path)')
    const id = `pin-${newId()}`
    const kind = /\.pdf$/i.test(file.name) ? 'pdf' : 'file'
    const pin: Pin = {
      id,
      workspaceId: workspace ?? 'default',
      uri: file.path,
      title: file.name,
      kind,
      ingest: { status: 'pending' },
      createdAt: new Date().toISOString(),
    }
    const created = await fetchFn(`${baseUrl}/pins`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(pin),
    })
    if (!created.ok) throw new Error(`attach: could not create pin (HTTP ${created.status})`)
    const q = workspace !== undefined ? `?workspace=${encodeURIComponent(workspace)}` : ''
    const ingested = await fetchFn(`${baseUrl}/pins/${encodeURIComponent(id)}/ingest${q}`, { method: 'POST' })
    if (!ingested.ok) throw new Error(`attach: ingest failed (HTTP ${ingested.status})`)
    const result = (await ingested.json()) as Pin
    if (result.ingest.status !== 'ingested') throw new Error(result.ingest.error ?? `attach: ${file.name} could not be ingested`)
    const summary = result.ingest.pages !== undefined ? `${result.ingest.pages} pages ingested` : `${result.ingest.chunks ?? 0} chunks ingested`
    return { pinId: id, title: file.name, summary }
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
  // Per-surface layout renderer (#133): the note-taker composes its three-zone frame via renderNotetaker
  // (signature-compatible with the generic renderSurface); every other surface uses the controller default.
  // Selected by surface id here so the Hud controller stays layout-agnostic (see HudOptions.renderSurface).
  const surfaceRenderer = resolvedSurfaceId === 'surf-openinfo-notetaker' ? renderNotetaker : undefined

  const style = doc.createElement('style')
  style.textContent = hudStyles + panelStyles // #134 input-block + attached-panel styles ride alongside the HUD chrome
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

  // In the Electron shell only: let the header strip drag the frameless window (preload.cts bridge).
  if (g.openinfoDrag) installWindowDrag(doc as unknown as Parameters<typeof installWindowDrag>[0], g.openinfoDrag)
  // NOTE: the content-size auto-resizer is NOT installed unconditionally here anymore. A window has exactly
  // ONE height authority (S1): a panel surface is sized by its PanelController, every other HUD window by
  // the content auto-resizer. Installing both let the resize floor (HUD_MIN_HEIGHT) override the panel's
  // extents (panel.ts). We now pick ONE in onSurfaceLoaded, once the surface (panel or not) is known.

  const copy = clipboardCopy(g.navigator, doc)
  // The verb write-paths (#15): both read-then-write against the live engine and reject on any HTTP
  // failure, so the mount layer paints visible success/failure text on the clicked button (never silent).
  const markDone = markTodoDone(baseUrl)
  const accept = acceptHintCandidate(baseUrl)
  const dismiss = dismissItem(baseUrl)
  const submitCorrection = submitEntityCorrection(baseUrl)
  const workspace = options.workspace ?? params.get('workspace') ?? undefined
  const transport = new BrowserTransport(baseUrl)
  // #134: the input block's live conversation controller. Its state (turns/attachment/status) lives here,
  // not in the DOM, so a destructive panel re-render never eats it — repaint() re-injects after every render.
  const inputSession = new InputSession({ submit: submitChat(baseUrl, workspace), upload: uploadAndIngest(baseUrl, workspace) })
  // #134: the attached-panel geometry controller — created from surface.panel once the doc loads (below).
  let panelController: PanelController | undefined
  // S1: the window's ONE height authority (PanelController or auto-resize) is installed exactly once.
  let sizerInstalled = false
  let mounted = false
  // Event-driven refresh failures re-enter the boot loop — visible, never an unhandled rejection.
  let onHudError: (error: unknown) => void = () => {}
  const hud = new Hud({
    transport,
    ...(options.workspace !== undefined ? { workspace: options.workspace } : {}),
    ...(resolvedSurfaceId !== undefined ? { surfaceId: resolvedSurfaceId } : {}),
    ...(surfaceRenderer !== undefined ? { renderSurface: surfaceRenderer } : {}),
    // #134: size the window to the declared attached panel (collapsed/expanded along its edge) and, for a
    // reveal:'event' panel, subscribe to the trigger to open it as a dismissible suggestion. Electron-only
    // (needs the panel bridge); a plain browser page simply scrolls. Created once — hot-reloads keep it.
    onSurfaceLoaded: (surface) => {
      // S4: the window names ITSELF in-content — drive document.title from the loaded surface's live name.
      // The framed titlebar / app switcher reflect it (page-title-updated flows by default); the frameless
      // HUD's identity is otherwise invisible, so this is where a window stops being an anonymous glass box.
      if (surface.name) doc.title = surface.name
      // S1: install the window's ONE height authority, exactly once. A panel surface (the chat/sidebar) is
      // sized by its PanelController along its edge; every other HUD window by the content auto-resizer. They
      // are mutually exclusive — installing both let the resize floor override the panel's extents (panel.ts).
      if (sizerInstalled) return
      const bridge = g.openinfoDrag
      if (surface.panel !== undefined) {
        if (!bridge?.panel) return // browser dev page has no bridge — nothing to size; retry on the next load
        panelController = new PanelController(surface.panel, { apply: (size) => bridge.panel!(size) }, transport)
        panelController.start()
        g.openinfoPanel = {
          toggle: () => panelController?.toggle(),
          expand: () => panelController?.expand(),
          collapse: () => panelController?.collapse(),
          dismissSuggestion: () => panelController?.dismissSuggestion(),
          state: () => panelController?.state() ?? { expanded: false, suggested: false },
        }
        sizerInstalled = true
      } else {
        // Content-size the frameless window to the painted panel (never the 100vh stage — see auto-resize.ts).
        if (bridge) installAutoResize(panel as unknown as Parameters<typeof installAutoResize>[0], bridge)
        sizerInstalled = true // in a plain browser (no bridge) there is nothing to install — the page scrolls
      }
    },
    onRender: (node) => {
      if (!mounted) {
        // #96: the system-stream mute is a client-local display toggle — flips Hud state + re-paints,
        // no network. The delegated listener lives on the container, so it survives every re-render.
        // #75: clarify-open/dismiss are client-local (Hud session state); the `clarify` answer writes over
        // the wire, then settles the ask (suppress this session) and refreshes so the confirmed row's ≟ is
        // gone. The server override is what makes the answer durable — the settle is the in-session gate.
        mountSurface(panel, node, {
          copy,
          markDone,
          accept,
          dismiss,
          muteSystemStream: () => hud.toggleSystemStream(),
          clarifyOpen: (entityId) => hud.openClarify(entityId),
          clarifyDismiss: (entityId) => hud.dismissClarify(entityId),
          clarify: async (payload) => {
            await submitCorrection(payload)
            hud.settleClarify(payload.entityId)
            await hud.refresh()
          },
        })
        // #134: install the input block's delegated submit/file listeners ONCE on the container (they
        // survive innerHTML replacement, exactly like wireActions' click delegation).
        inputSession.install(panel as unknown as Parameters<InputSession['install']>[0])
        mounted = true
      } else {
        renderInto(panel, node)
      }
      // #134: re-inject the input block's conversation/attachment/status after EVERY render (the pure
      // renderer leaves those regions empty) — the compose-after-render discipline the live strip uses.
      inputSession.repaint(panel as unknown as Parameters<InputSession['repaint']>[0])
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
