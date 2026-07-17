import type { AttributionPattern, BlockQuery, Bundle, ChatReply, ChatScreenshot, ChatTurn, Pin, PromptTemplate, QueryResult, Session, Surface, TodoList, WorkspaceHints } from '@openinfo/contracts'
import { mountSurface, renderInto, type MountTarget, type SessionReadiness } from '../block-renderer/index.js'
import { Hud } from './hud.js'
import { backoffMs, createBootController } from './boot.js'
import type { HudTransport } from './transport.js'
import { hudStyles, hudOutlineStyles } from './styles.js'
import { renderNotetaker } from './notetaker-layout.js'
import { panelStyles } from './panel-styles.js'
import { pillStyles } from './pill-styles.js'
import { createPillRenderer, type PillFaceSources } from './pill-layout.js'
import { PillController, pillExtentsFromPanel, type PillState } from './pill.js'
import { installWindowDrag, type DragBridge } from './window-drag.js'
import { installAutoResize, type ResizeBridge } from './auto-resize.js'
import { PanelController, type PanelSize } from './panel.js'
import { InputSession, type AttachedDoc, type CaptureOutcome, type ChatThread, type UploadFile } from './input-submit.js'

/** The pill surface id — the surface whose window is the pill (its renderer + height authority differ). */
const PILL_SURFACE_ID = 'surf-openinfo-pill'

/**
 * PURE: which surface backs the pill's Ask face, resolved FROM THE BUNDLE (data, not a hardcoded window).
 * Find the bundle whose `hud` face opens this pill, then return its `chat` face's surfaceRef — so a
 * different bundle produces a different Ask panel. Falls back to any bundle that opens this pill as its hud
 * face (order-independent), and returns undefined when no such bundle has a chat face (an honest absence).
 */
export const chatFaceRefForPill = (bundles: readonly Bundle[], pillSurfaceId: string): string | undefined => {
  const owning = bundles.find((b) => b.faces.some((f) => f.kind === 'hud' && f.surfaceRef === pillSurfaceId))
  const chat = owning?.faces.find((f) => f.kind === 'chat')
  return chat?.surfaceRef
}

/**
 * The ONE terminal resolve outcome: GET /bundles ANSWERED and the data says no bundle gives this pill a
 * chat face. Retrying is pointless (the answer is authoritative data, not a flaky wire), so the ask-resolve
 * controller stops on this error — every OTHER rejection (the engine-spawn race, a non-ok read, a failed
 * surface fetch) is transient and keeps the retry loop alive. The distinction is a TYPE, not a message
 * match, so a rewording can never silently turn a data answer back into an infinite retry (or vice versa).
 */
export class NoChatFaceError extends Error {}

/**
 * Resolve the pill's Ask-face surface over the wire: GET /bundles → the chat face surfaceRef (bundle data)
 * → GET /layouts/surfaces/:ref. Rejects with an HONEST reason (no bundle opens this pill, the bundle has no
 * chat face, or a failed read) that the pill paints as visible text — never a silent blank Ask panel. The
 * no-chat-face case rejects with the TYPED NoChatFaceError (terminal); everything else is transient.
 */
export const resolvePillAskSurface =
  (baseUrl: string, transport: Pick<HudTransport, 'surface'>, fetchFn: FetchLike = fetch) =>
  async (pillSurfaceId: string): Promise<Surface> => {
    const res = await fetchFn(`${baseUrl}/bundles`)
    if (!res.ok) throw new Error(`the app bundle could not be read (HTTP ${res.status})`)
    const bundles = (await res.json()) as Bundle[]
    const ref = chatFaceRefForPill(bundles, pillSurfaceId)
    if (ref === undefined) throw new NoChatFaceError('this app has no chat face')
    return transport.surface(ref)
  }

export interface AskResolveDeps {
  /** One resolve attempt (resolvePillAskSurface). Rejection ⇒ retry, unless it is a NoChatFaceError. */
  resolve: () => Promise<Surface>
  /** The chat face resolved — flip the Ask affordance live and repaint. */
  onResolved: (surface: Surface) => void
  /** The bundle GENUINELY has no chat face (GET /bundles answered) — the one terminal stop, no more retries. */
  onNoChatFace: (reason: string) => void
  /** A transient failure; the retry is already scheduled — log the underlying error so there is a trace. */
  onRetry: (error: unknown, attempt: number) => void
  /** Injectable timer (tests use a manual scheduler). */
  schedule?: (fn: () => void, ms: number) => void
}

/**
 * The Ask-face resolve controller — the same posture as createBootController, for the SAME race: the
 * packaged shell creates the pill window BEFORE `ensureEngine()` spawns the bundled engine (shell.ts), so
 * the first GET /bundles typically loses that race. The old one-shot `.then/.catch` made that loss
 * PERMANENT — `setAskAvailable(false)` stuck forever and the Ask affordance (the door to the whole chat
 * box) was dead on every packaged cold boot. This retries with the boot controller's capped backoff
 * (backoffMs) until the resolve succeeds, and stops ONLY on the typed NoChatFaceError — the one outcome
 * where retrying is pointless because the engine answered and the data says there is no chat face.
 */
export const createAskResolveController = (deps: AskResolveDeps): { start: () => void } => {
  const schedule = deps.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  let attempt = 0
  let settled = false

  const tryResolve = (): void => {
    deps.resolve().then(
      (surface) => {
        settled = true
        deps.onResolved(surface)
      },
      (error: unknown) => {
        if (error instanceof NoChatFaceError) {
          settled = true
          deps.onNoChatFace(error.message)
          return
        }
        attempt += 1
        deps.onRetry(error, attempt)
        schedule(tryResolve, backoffMs(attempt))
      },
    )
  }

  return {
    start: () => {
      if (settled) return
      tryResolve()
    },
  }
}

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
  constructor(private readonly baseUrl: string, private readonly fetchFn: FetchLike = fetch) {}

  async surface(id: string): Promise<Surface> {
    return this.getJson(`/layouts/surfaces/${encodeURIComponent(id)}`) as Promise<Surface>
  }

  async query(query: BlockQuery, surfaceId?: string): Promise<QueryResult> {
    const suffix = surfaceId === undefined ? '' : `?surface=${encodeURIComponent(surfaceId)}`
    const response = await this.fetchFn(`${this.baseUrl}/query${suffix}`, {
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
    const response = await this.fetchFn(`${this.baseUrl}${path}`)
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
  /** THE PILL control seam (the-pill) — drives the face toggle / Show-Hide and reads state (header + e2e). */
  openinfoPill?: {
    face(face: 'listen' | 'ask'): void
    toggle(): void
    state(): PillState
  }
  /** The pill's settings-on-hover bridge (preload.cts) — opens the EXISTING settings path in the shell. */
  openinfoShell?: {
    openSettings(): void
  }
  /**
   * The #136 session bridge (preload.cts) — the on-surface session control's reach to the shell. `start`/
   * `stop` dispatch through the SAME tray session path (consent granted/revoked in main); `state()` returns
   * the latest readiness main pushed. Absent in a plain browser / served frame ⇒ the control renders disabled.
   */
  openinfoSession?: {
    start(): void
    stop(): void
    state(): SessionReadiness
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

/** Renderer requests get their bearer in Electron's main-process webRequest listener, never in JS state. */
export const retryOnceOnUnauthorized =
  (fetchFn: FetchLike = fetch): FetchLike =>
  async (input, init) => {
    const first = await fetchFn(input, init)
    if (first.status !== 401) return first
    return fetchFn(input, init)
  }

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
  async (input: { target: string; route: string; message: string; pinId?: string; history: ChatTurn[]; screenshot?: ChatScreenshot; turnId: string }): Promise<ChatReply> => {
    const body: Record<string, unknown> = { message: input.message, history: input.history, turnId: input.turnId }
    if (workspace !== undefined) body['workspace'] = workspace
    if (input.pinId !== undefined) body['pinId'] = input.pinId
    if (input.screenshot !== undefined) body['screenshot'] = input.screenshot
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
 * The Ask face's screenshot-on-send dep: ask the SHELL for one frame over the preload capture bridge
 * (`window.openinfoScreen`, main-process desktopCapturer behind the consent gate). No bridge — a plain
 * browser / served test — is itself an honest outcome: the send proceeds frameless and says why. The
 * bridge's discriminated { ok, frame|reason } is validated shape-first so a malformed answer can never
 * masquerade as a frame.
 */
export const captureScreenViaBridge = async (): Promise<CaptureOutcome> => {
  const bridge = (globalThis as { openinfoScreen?: { captureFrame(): Promise<unknown> } }).openinfoScreen
  if (!bridge) return { ok: false, reason: 'screen capture needs the desktop app' }
  try {
    const outcome = (await bridge.captureFrame()) as { ok?: unknown; frame?: { contentType?: unknown; data?: unknown }; reason?: unknown }
    if (outcome && outcome.ok === true && outcome.frame && typeof outcome.frame.data === 'string' && typeof outcome.frame.contentType === 'string') {
      return { ok: true, frame: outcome.frame as ChatScreenshot }
    }
    return { ok: false, reason: typeof outcome?.reason === 'string' ? outcome.reason : 'screen capture returned no frame' }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Resolve the Ask face's default question — the tpl-ask-default DOCUMENT body over the existing
 * GET /templates/:id read (fresh per empty send, so a PUT /templates edit takes effect immediately;
 * #130: a shipped document, never a string baked into the client). Honest failure: a non-ok read or an
 * empty body REJECTS with the reason the input block paints.
 */
export const fetchDefaultAsk =
  (baseUrl: string, fetchFn: FetchLike = fetch) =>
  async (): Promise<string> => {
    const res = await fetchFn(`${baseUrl}/templates/tpl-ask-default`)
    if (!res.ok) throw new Error(`the default ask document could not be read (HTTP ${res.status})`)
    const template = (await res.json()) as PromptTemplate
    if (typeof template.body !== 'string' || template.body.trim() === '') throw new Error('the default ask document has an empty body')
    return template.body
  }

/**
 * Rehydrate the workspace's persisted chat thread (GET /chat/history) so the chat window opens
 * mid-conversation — the owner's app-scoped persistent thread. Honest failure: a non-ok read rejects
 * with the status; the caller surfaces it as visible text (an older engine without the route reads as
 * exactly that, not as an empty thread).
 */
export const fetchChatHistory =
  (baseUrl: string, workspace: string | undefined, fetchFn: FetchLike = fetch) =>
  async (): Promise<ChatThread> => {
    const q = workspace !== undefined ? `?workspace=${encodeURIComponent(workspace)}` : ''
    const res = await fetchFn(`${baseUrl}/chat/history${q}`)
    if (!res.ok) throw new Error(`chat history could not be read (HTTP ${res.status})`)
    return (await res.json()) as ChatThread
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
    const ingested = await fetchFn(`${baseUrl}/pins/${encodeURIComponent(id)}/ingest${q}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
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
  // THE PILL (the-pill): its own view-state + resolved face sources, read by the pill renderer closure.
  // `pillState` is a GETTER so the renderer works before the PillController is built (in onSurfaceLoaded);
  // `pillSources` is the mutable Ask-face resolution (GET /bundles → chat face surface), filled async.
  const isPill = resolvedSurfaceId === PILL_SURFACE_ID
  let pill: PillController | undefined
  const pillSources: PillFaceSources = { chat: null, resolving: isPill }
  const pillState = (): PillState => pill?.state() ?? { face: 'listen', open: true, askAvailable: false }

  // Per-surface layout renderer: the note-taker composes its three-zone frame (renderNotetaker); the pill
  // composes its header-bar + docked-panel frame (createPillRenderer). Both are signature-compatible with
  // the generic renderSurface; every other surface uses the controller default. Selected by surface id here
  // so the Hud controller stays layout-agnostic (see HudOptions.renderSurface).
  const surfaceRenderer = isPill
    ? createPillRenderer(pillState, () => pillSources)
    : resolvedSurfaceId === 'surf-openinfo-notetaker'
      ? renderNotetaker
      : undefined

  const style = doc.createElement('style')
  style.textContent = hudStyles + panelStyles + pillStyles // #134 input/panel + the-pill styles ride alongside the HUD chrome
  // Debug outline (?outline=1, from OPENINFO_HUD_OUTLINE / client.json hudOutline): the window is
  // frameless + transparent, so when nothing paints there is NOTHING to see. The outline draws the
  // window bounds + the panel bounds so "where does the HUD render" is answerable by looking.
  if (params.get('outline')) style.textContent += hudOutlineStyles
  doc.head.appendChild(style)
  const stage = doc.createElement('div')
  stage.className = isPill ? 'stage pill-stage' : 'stage'
  // The boot-status chip: every boot/runtime failure paints here as text (a transparent window must
  // never fail invisibly — the same honesty rule the settings save strip follows). Empty when healthy.
  const status = doc.createElement('div')
  status.className = 'hud-boot-status'
  const panel = doc.createElement('div')
  // THE PILL fills its FIXED-width window (it is not content-sized like the HUD). The mount div is a flex
  // item of the centered `.stage`, so by default it shrink-wraps to the pill's intrinsic content and the
  // pill floats centered as a microsquare (a 295px bar in a 708px window). Tagging the mount lets pill-styles
  // give it a definite width (the stage content box), so `.pill-app`'s width:100% finally resolves to a fill.
  if (isPill) panel.className = 'pill-mount'
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
  // Electron main injects Authorization only after requests leave this trusted renderer. A 401 causes its
  // centralized listener to reload discovery before this wrapper's one retry; no bearer enters JS state.
  const engineFetch = retryOnceOnUnauthorized(fetch)
  // The verb write-paths (#15): both read-then-write against the live engine and reject on any HTTP
  // failure, so the mount layer paints visible success/failure text on the clicked button (never silent).
  const markDone = markTodoDone(baseUrl, engineFetch)
  const accept = acceptHintCandidate(baseUrl, engineFetch)
  const dismiss = dismissItem(baseUrl, engineFetch)
  const submitCorrection = submitEntityCorrection(baseUrl, engineFetch)
  const workspace = options.workspace ?? params.get('workspace') ?? undefined
  const transport = new BrowserTransport(baseUrl, engineFetch)
  // #134: the input block's live conversation controller. Its state (turns/attachment/status) lives here,
  // not in the DOM, so a destructive panel re-render never eats it — repaint() re-injects after every render.
  // Ask face deps ride alongside the S2 attach bridge: one frame per send (captureScreenViaBridge), the
  // default-ask document for an empty send, and the streamed-delta ingest wired through the Hud below.
  const inputSession = new InputSession({
    submit: submitChat(baseUrl, workspace, engineFetch),
    upload: uploadAndIngest(baseUrl, workspace, engineFetch),
    captureScreen: captureScreenViaBridge,
    defaultAsk: fetchDefaultAsk(baseUrl, engineFetch),
    // #222: flush a re-render that was deferred while the user was mid-IME-composition (the composition
    // must never be interrupted by a wipe). Invoked only at compositionend, after `hud` is constructed below.
    requestRender: () => hud.rerender(),
  })
  // Ask-history: rehydrate the workspace's persisted thread so the chat window opens mid-conversation
  // (seedHistory never clobbers a live session; the paint lands with the next render). A failed read is
  // logged to the console (visible in the shell's log surface) — the thread simply starts empty, and the
  // engine's own responses still disclose their state per turn.
  void fetchChatHistory(baseUrl, workspace, engineFetch)()
    .then((thread) => inputSession.seedHistory(thread))
    .catch((error: unknown) => console.error(`[chat] history rehydrate failed: ${error instanceof Error ? error.message : String(error)}`))
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
    // Ask face: streamed-reply deltas ride the Hud's ONE event socket, payload-fed (see hud.ts) — the
    // InputSession appends each to its in-flight turn and re-paints, no query.
    onChatDelta: (payload) => inputSession.ingestDelta(payload),
    // #136: the on-surface session control's readiness — read FRESH from the shell bridge each render (a
    // pure state read, no fetch). Absent (a plain browser / served frame) ⇒ undefined, so the control
    // renders its honest disabled state. Main pushes fresh snapshots over hud:session-state on every change.
    sessionReadiness: () => g.openinfoSession?.state(),
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
      // THE PILL (the-pill): its ONE height authority is the PillController — three extents (bar / listen /
      // ask) over the SAME hud:panel-size bridge PanelController uses (S1: installed instead of it). Created
      // even without the bridge (browser dev) with a no-op sizer, so the face toggle still re-paints there.
      if (isPill && surface.panel !== undefined) {
        const extents = pillExtentsFromPanel(surface.panel)
        const pillBridge = bridge?.panel ? { apply: (size: { height: number }) => bridge.panel!(size) } : { apply: () => {} }
        pill = new PillController({
          extents,
          bridge: pillBridge,
          onChange: () => hud.rerender(),
          startOpen: surface.panel.startExpanded ?? true,
        })
        pill.setAskAvailable(pillSources.chat !== null) // in case the bundle resolved before this load
        pill.start()
        g.openinfoPill = {
          face: (face) => pill?.setFace(face),
          toggle: () => pill?.toggle(),
          state: () => pill?.state() ?? { face: 'listen', open: true, askAvailable: false },
        }
        sizerInstalled = true
        return
      }
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
          // THE PILL (the-pill): header verbs — client-local view state (PillController), no writes. The
          // settings-on-hover gear opens the EXISTING settings path over the shell bridge (a plain browser
          // without the bridge is an honest no-op).
          pillFace: (face) => pill?.setFace(face),
          pillToggle: () => pill?.toggle(),
          pillSettings: () => g.openinfoShell?.openSettings(),
          // #136: the on-surface session control — start/stop dispatch to the shell over the session bridge,
          // which runs the SAME tray command path (consent granted/revoked in main). A browser without the
          // bridge leaves the control disabled, so these never fire there (an honest no-op regardless).
          sessionStart: () => g.openinfoSession?.start(),
          sessionStop: () => g.openinfoSession?.stop(),
        })
        // #134: install the input block's delegated submit/file listeners ONCE on the container (they
        // survive innerHTML replacement, exactly like wireActions' click delegation).
        inputSession.install(panel as unknown as Parameters<InputSession['install']>[0])
        mounted = true
        // #134: re-inject the input block's conversation/attachment/status after the initial mount (the
        // pure renderer leaves those regions empty) — the compose-after-render discipline the live strip uses.
        inputSession.repaint(panel as unknown as Parameters<InputSession['repaint']>[0])
      } else {
        // #222 chat-focus repair: a focus/caret/IME-preserving re-render. renderInto still wipes innerHTML
        // (destroying the textarea), but rerenderInto snapshots focus + caret before the wipe and restores
        // them in its own paired repaint after — so the ~1/s live refresh no longer steals focus mid-type —
        // and DEFERS the wipe entirely while an IME composition is in flight (flushed on compositionend).
        inputSession.rerenderInto(
          panel as unknown as Parameters<InputSession['rerenderInto']>[0],
          () => renderInto(panel, node),
        )
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

  // THE PILL (the-pill): resolve the Ask face FROM THE BUNDLE (data, not a hardcoded window) — GET
  // /bundles → the chat face surfaceRef → its surface doc. Through the RETRY controller, NOT a one-shot
  // `.then/.catch`: the packaged shell creates this window BEFORE its bundled engine spawns (the same race
  // the boot controller above exists for), and the old one-shot lost it permanently — setAskAvailable(false)
  // stuck forever, so the Ask button (the door to the whole chat box) was dead on every packaged cold boot.
  // Success ⇒ the Ask affordance lights up and the panel mounts the resolved chat organs; the ONE terminal
  // failure (the bundle genuinely has no chat face) paints its honest reason; every transient failure is
  // logged and retried with the boot controller's capped backoff. Each outcome re-paints via hud.rerender().
  if (isPill && resolvedSurfaceId !== undefined) {
    createAskResolveController({
      resolve: () => resolvePillAskSurface(baseUrl, transport, engineFetch)(resolvedSurfaceId),
      onResolved: (chatSurface) => {
        pillSources.chat = chatSurface
        pillSources.resolving = false
        delete pillSources.chatError
        pill?.setAskAvailable(true)
        hud.rerender()
      },
      onNoChatFace: (reason) => {
        pillSources.resolving = false
        pillSources.chatError = reason
        pill?.setAskAvailable(false)
        console.error(`[pill] the Ask face is unavailable: ${reason}`)
        hud.rerender()
      },
      onRetry: (error, attempt) => {
        // The trace the old .catch never left: why THIS attempt failed. The visible surface stays in its
        // honest catching-up state (pillSources.resolving remains true) while the retry ladder runs.
        console.error(`[pill] Ask face resolve failed (attempt ${attempt}): ${error instanceof Error ? error.message : String(error)} — retrying`)
      },
    }).start()
  }
}

// Auto-start when loaded as a module in a browser document.
{
  const g = globalThis as unknown as DevGlobal
  if (g.document) {
    if (g.document.readyState === 'loading') g.document.addEventListener('DOMContentLoaded', () => startHud())
    else startHud()
  }
}
