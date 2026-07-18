import type { Block, BlockQuery, CaptureSource, Moment, QueryResult, Session, Surface } from '@openinfo/contracts'
import { renderSurface, clockLabel, elapsedLabel, type BlockRegistry, type NowContext, type SessionReadiness, type SurfaceRenderInput, type VElement } from '../block-renderer/index.js'
import { defaultBlockRegistry } from '../blocks/index.js'
import { pruneTranscript, renderLiveTranscript, type TranscriptLine } from './live-transcript.js'
import { patchLiveSenseResults, reconcileLiveSenseHydration, sanitizeSenseLaneSnapshot } from './sense-lane-cache.js'
import type { HudTransport } from './transport.js'

const DEFAULT_SURFACE_ID = 'surf-openinfo-hud'

/**
 * Live-update strategy: which events invalidate the hydrated data (see PHASE2-NOTES — re-query).
 * 'ws.open' is synthesized by the transport whenever its event socket (re)connects — events during an
 * engine restart are missed, so a fresh socket re-hydrates once to catch up (coalesced; harmless on the
 * very first open, which lands right after start()'s own refresh).
 */
const REFRESH_EVENTS = new Set(['moment.created', 'entity.updated', 'distillate.updated', 'session.started', 'session.ended', 'session.titled', 'ws.open'])

/** The ephemeral live-transcript fast-path event (#58) — PAYLOAD-fed, not a query-refresh trigger. */
const TRANSCRIPT_EVENT = 'transcript.updated'
/** Metadata-only live-sense fast path. The authenticated query remains the hydration authority. */
const SENSE_LANE_EVENT = 'sense.lane.updated'
/** The ephemeral streamed-chat-answer event (the Ask face) — PAYLOAD-fed exactly like the transcript. */
const CHAT_DELTA_EVENT = 'chat.delta'
/** Session boundaries reset the live feed — a new/ended session starts a fresh transcript. */
const TRANSCRIPT_RESET_EVENTS = new Set(['session.started', 'session.ended'])

export interface HudOptions {
  transport: HudTransport
  onRender: (panel: VElement) => void
  surfaceId?: string
  workspace?: string
  registry?: BlockRegistry
  /**
   * The surface renderer. Defaults to the generic `renderSurface`; a surface with a bespoke layout (the
   * #133 note-taker three-zone frame) injects its own signature-compatible renderer here (dev-entry picks
   * it by surface id). Kept injectable rather than branched in the controller so the controller stays
   * layout-agnostic — it still renders(document) and live-updates identically, whatever the layout.
   */
  renderSurface?: (input: SurfaceRenderInput, registry: BlockRegistry) => VElement
  /** injectable clock so the Now-line elapsed is testable */
  now?: () => Date
  /**
   * Called when an event-driven async operation (a WS-triggered refresh or surface reload) rejects.
   * Without it those rejections were unhandled and INVISIBLE — in a transparent window that reads as
   * "the HUD disappeared". The dev entry routes this into the boot controller's restart loop.
   */
  onError?: (error: unknown) => void
  /**
   * Called with the loaded surface DOCUMENT after start() (and each hot-reload). A seam for shell-side
   * wiring that keys off the document itself — the #134 attached-panel geometry reads `surface.panel` here
   * to size the window. Additive/optional: absent ⇒ unchanged behavior. The renderer never fetches; this
   * simply hands over the doc the Hud already loaded, so no extra request is made.
   */
  onSurfaceLoaded?: (surface: Surface) => void
  /**
   * Called with each ephemeral `chat.delta` payload (the Ask face streamed reply) — routed PAYLOAD-fed
   * over the Hud's ONE event socket, handled-and-returned before the refresh set exactly like the
   * transcript fast-path (payload events re-paint, they never re-hydrate). The dev entry feeds this to
   * the InputSession, which appends the delta to its in-flight turn. Additive/optional.
   */
  onChatDelta?: (payload: unknown) => void
  /**
   * #136: the on-surface session control's can-this-act signal, read FRESH on every render (like the pill's
   * state getter) so a change in engine/capture readiness repaints the control without a re-query. The dev
   * entry supplies it from the shell's openinfoSession bridge; absent ⇒ no bridge (browser dev / served
   * frame), so the control renders its disabled, disclosed state. Never fetches — a pure state read.
   */
  sessionReadiness?: () => SessionReadiness | undefined
  /**
   * Remap a block's query before it is hydrated, read FRESH on every refresh (a pure function of the block +
   * whatever view-state the caller closes over). Returns the query to run, or undefined to use `block.query`
   * unchanged. The controller stays layout-agnostic: it neither knows nor cares WHY a query changed. The
   * note-taker uses this for its session-history drill-down (#247) — when a past session is selected it
   * rewrites the CENTER session-scoped blocks from `session: 'current'` to the selected past-session id, so a
   * plain `hud.refresh()` re-hydrates the center against that session. Absent ⇒ every block uses its own query.
   */
  mapQuery?: (block: Block) => BlockQuery | undefined
}

/**
 * The live HUD controller. It loads the surface DOCUMENT once, hydrates each block's query through the
 * engine, renders the panel via the (document-driven) block renderer, and re-renders on live WS events.
 *
 * Ranked/joined data updates by RE-QUERY (PHASE2-NOTES): the engine owns that logic. Two closed fast paths
 * are payload-fed: raw transcript lines and metadata-only live-sense snapshots. A lane event can replace
 * one source only after an authenticated canonical query hydrated its scope; reconnect/session boundaries
 * reset that cache and re-query. Rapid invalidation events are coalesced so a burst causes one refresh.
 */
export class Hud {
  private readonly transport: HudTransport
  private readonly onRender: (panel: VElement) => void
  private readonly surfaceId: string
  private readonly workspace: string
  private readonly registry: BlockRegistry
  private readonly renderSurface: (input: SurfaceRenderInput, registry: BlockRegistry) => VElement
  private readonly clock: () => Date

  private readonly onError: ((error: unknown) => void) | undefined
  private readonly onSurfaceLoaded: ((surface: Surface) => void) | undefined
  private readonly onChatDelta: ((payload: unknown) => void) | undefined
  private readonly sessionReadiness: (() => SessionReadiness | undefined) | undefined
  private readonly mapQuery: ((block: Block) => BlockQuery | undefined) | undefined

  private surface: Surface | undefined
  private results: (QueryResult | undefined)[] = []
  private session: Session | undefined
  // The live-transcript rolling buffer (#58) — EVENT-fed, not query-fed (see live-transcript.ts). Held
  // client-side; the engine never persists it. Pruned on every repaint and reset on session boundaries.
  private transcriptLines: TranscriptLine[] = []
  private transcriptSeq = 0
  // #96: hide the system-audio stream from the live strip WITHOUT disabling capture. Client-local and
  // session-ephemeral (a reload starts unmuted) — a display filter over the strip, never a capture change.
  // The two streams stay separate here and are only ATTRIBUTED/FILTERED, never merged (see live-transcript.ts).
  private systemStreamMuted = false
  // #75 clarify affordance session state (client-local, session-ephemeral like systemStreamMuted): the
  // entities the user already answered/dismissed this session (no ≟ re-asks), and the single ambiguous
  // entity whose inline ask is currently expanded. A reload starts empty — the SERVER-side override is what
  // makes a confirmed answer durable across sessions; this set is only the at-most-once-per-session gate.
  private clarifySuppressed = new Set<string>()
  private clarifyExpanded: string | undefined
  private unsubscribe: (() => void) | undefined
  private refreshing = false
  private dirty = false

  constructor(options: HudOptions) {
    this.transport = options.transport
    this.onRender = options.onRender
    this.surfaceId = options.surfaceId ?? DEFAULT_SURFACE_ID
    this.workspace = options.workspace ?? 'default'
    this.registry = options.registry ?? defaultBlockRegistry
    this.renderSurface = options.renderSurface ?? renderSurface
    this.clock = options.now ?? (() => new Date())
    this.onError = options.onError
    this.onSurfaceLoaded = options.onSurfaceLoaded
    this.onChatDelta = options.onChatDelta
    this.sessionReadiness = options.sessionReadiness
    this.mapQuery = options.mapQuery
  }

  /** Load the surface document, hydrate + render once, then start listening for live updates. */
  async start(): Promise<void> {
    this.surface = await this.transport.surface(this.surfaceId)
    this.onSurfaceLoaded?.(this.surface)
    await this.refresh()
    this.unsubscribe = this.transport.subscribe((event) => {
      // A layout edit to THIS surface (surface.updated over the WS, PHASE3-NOTES) hot-reloads the
      // document — the user edits the HUD in /setup and it re-renders within a second, no restart.
      // Events for OTHER surfaces are ignored (the HUD renders exactly one).
      if (event.name === 'surface.updated') {
        const payload = event.payload as { id?: unknown } | null
        // A rejection here (or below) used to be an UNHANDLED promise — silent in a transparent window.
        // Route it to onError so the shell can show it and re-enter the boot loop (see boot.ts).
        if (payload && payload.id === this.surfaceId) this.reloadSurface().catch((err: unknown) => this.onError?.(err))
        return
      }
      // The transcript fast-path (#58) carries its payload to render DIRECTLY — it is NOT a query-refresh
      // trigger (that is the coalescing discipline: payload events re-paint, they do not re-hydrate). It
      // is handled before REFRESH_EVENTS and returns so it never triggers the expensive query path.
      if (event.name === TRANSCRIPT_EVENT) {
        this.ingestTranscript(event.payload)
        return
      }
      // A live-sense update patches only an already-hydrated, matching lane cache. Runtime validation is
      // strict and closed: malformed, cross-scope, or widened payloads are ignored without a query.
      if (event.name === SENSE_LANE_EVENT) {
        this.ingestSenseLane(event.payload)
        return
      }
      // The streamed-chat fast-path (the Ask face) rides the same discipline: payload out to its consumer
      // (the InputSession's in-flight turn), no query, handled-and-returned before the refresh set.
      if (event.name === CHAT_DELTA_EVENT) {
        this.onChatDelta?.(event.payload)
        return
      }
      // A session boundary starts a fresh live feed; fall through to the normal refresh below.
      if (TRANSCRIPT_RESET_EVENTS.has(event.name)) {
        this.transcriptLines = []
        this.resetLiveSenseHydration()
      }
      if (REFRESH_EVENTS.has(event.name)) this.scheduleRefresh().catch((err: unknown) => this.onError?.(err))
    })
  }

  /** Re-fetch the surface document (a layout edit), then re-hydrate + render through the coalescer. */
  async reloadSurface(): Promise<void> {
    this.surface = await this.transport.surface(this.surfaceId)
    this.onSurfaceLoaded?.(this.surface)
    await this.scheduleRefresh()
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  /**
   * Toggle whether the system-audio stream is shown in the live strip (#96). This is a DISPLAY filter
   * only — capture, the transcript-inspector, and distill are untouched; the state is client-local and
   * session-ephemeral. Wired from the strip's `mute-system-stream` verb (see dev-entry.ts / mount.ts);
   * flips the flag and re-paints synchronously (no query, no re-hydrate — the live-feed discipline).
   */
  toggleSystemStream(): void {
    this.systemStreamMuted = !this.systemStreamMuted
    this.render()
  }

  /**
   * Expand the #75 clarify ask for one ambiguous entity (the ≟ was clicked). Only one ask is open at a
   * time; a no-op re-paint otherwise. Client-local — no query, no re-hydrate (the live-feed discipline).
   */
  openClarify(entityId: string): void {
    if (this.clarifySuppressed.has(entityId)) return // already settled this session — the ≟ is gone
    this.clarifyExpanded = entityId
    this.render()
  }

  /**
   * Dismiss the #75 clarify ask ("ask me later") — teaches NOTHING. The entity enters the session
   * suppressed set so no ≟ renders for it again this session, and the open ask collapses. Client-local.
   */
  dismissClarify(entityId: string): void {
    this.clarifySuppressed.add(entityId)
    if (this.clarifyExpanded === entityId) this.clarifyExpanded = undefined
    this.render()
  }

  /**
   * Mark a clarify ask SETTLED after its answer wrote a sovereign override server-side (see dev-entry's
   * clarify orchestrator). Suppresses the entity this session and collapses the ask; the follow-on refresh
   * re-hydrates the now-confirmed row (whose ambiguity the override cleared), so the ≟ is gone for good.
   */
  settleClarify(entityId: string): void {
    this.clarifySuppressed.add(entityId)
    if (this.clarifyExpanded === entityId) this.clarifyExpanded = undefined
    this.render()
  }

  /**
   * Re-paint with the CURRENT data (no re-hydrate, no query) — a client-local VIEW-STATE change, the same
   * shape as toggleSystemStream/openClarify but driven from OUTSIDE the controller (the pill's face/Show-
   * Hide toggle owns its state in the PillController and calls this to repaint). No-op before the first
   * surface load (render guards on surface).
   */
  rerender(): void {
    this.render()
  }

  /** Re-derive the live session and re-hydrate every block query, then render. */
  async refresh(): Promise<void> {
    if (!this.surface) return
    const surface = this.surface
    const [live, results] = await Promise.all([
      this.transport.sessions({ workspace: this.workspace, live: true }),
      Promise.all(
        surface.stack.map((block) => {
          // A caller-supplied view-state may remap the query (the #247 drill-down); absent ⇒ the block's own.
          const query = (this.mapQuery ? this.mapQuery(block) : undefined) ?? block.query
          return query ? this.transport.query(query, surface.id) : Promise.resolve(undefined)
        }),
      ),
    ])
    // A lane event can land while this query is in flight. Reconcile same-scope rows by updatedAt so the
    // older response snapshot cannot overwrite newer payload truth; a different query scope still wins.
    this.session = live[0]
    this.results = reconcileLiveSenseHydration(surface, this.results, results)
    this.render()
  }

  /** Coalesce a burst of events into a single trailing refresh. */
  private async scheduleRefresh(): Promise<void> {
    if (this.refreshing) {
      this.dirty = true
      return
    }
    this.refreshing = true
    try {
      do {
        this.dirty = false
        await this.refresh()
      } while (this.dirty)
    } finally {
      this.refreshing = false
    }
  }

  private render(): void {
    if (!this.surface) return
    const now = this.buildNow()
    const clarify = { suppressed: this.clarifySuppressed, ...(this.clarifyExpanded !== undefined ? { expanded: this.clarifyExpanded } : {}) }
    // #136: read the session-control readiness fresh each render (a pure state read, never a fetch) so a
    // change in engine/capture state repaints the on-surface control. Absent ⇒ no shell bridge (disabled).
    const session = this.sessionReadiness?.()
    const panel = this.renderSurface({ surface: this.surface, now, results: this.results, clarify, ...(session !== undefined ? { session } : {}) }, this.registry)
    // Compose the event-fed live-transcript feed onto the query-rendered panel (#58). Pruned here so the
    // feed self-expires on every repaint; appended LAST so the distilled blocks keep primacy and the raw
    // live strip reads as a distinct layer beneath them. Absent (idle, nothing to say) ⇒ panel unchanged.
    const nowMs = this.clock().getTime()
    this.transcriptLines = pruneTranscript(this.transcriptLines, nowMs)
    const feed = renderLiveTranscript(this.transcriptLines, { live: now.live, nowMs, systemMuted: this.systemStreamMuted })
    this.onRender(feed ? { ...panel, children: [...panel.children, feed] } : panel)
  }

  /**
   * Ingest one transcript.updated payload into the rolling buffer and re-paint (#58). Defensive about
   * the payload shape (a malformed frame is ignored, never a throw into the WS handler). Re-paints
   * synchronously: each WS frame is its own event-loop turn, so this is already one paint per event —
   * no query, no re-hydrate (the coalescing discipline). A paint before the first surface load is a
   * no-op (render guards on surface), but the line is still buffered for the next paint.
   */
  private ingestTranscript(payload: unknown): void {
    const line = this.toTranscriptLine(payload)
    if (!line) return
    this.transcriptLines.push(line)
    this.render()
  }

  private ingestSenseLane(payload: unknown): void {
    if (!this.surface) return
    const lane = sanitizeSenseLaneSnapshot(payload)
    if (!lane) return
    const results = patchLiveSenseResults({
      surface: this.surface,
      results: this.results,
      lane,
    })
    if (!results) return
    this.results = results
    this.render()
  }

  private resetLiveSenseHydration(): void {
    if (!this.surface) return
    this.results = this.results.map((result, index) =>
      this.surface?.stack[index]?.query?.source === 'live-senses' ? undefined : result,
    )
  }

  private toTranscriptLine(payload: unknown): TranscriptLine | undefined {
    if (typeof payload !== 'object' || payload === null) return undefined
    const p = payload as { source?: unknown; text?: unknown; capturedAtRange?: { end?: unknown } | null }
    if (typeof p.source !== 'string' || typeof p.text !== 'string' || p.text.length === 0) return undefined
    const endRaw = p.capturedAtRange && typeof p.capturedAtRange === 'object' ? p.capturedAtRange.end : undefined
    const parsed = typeof endRaw === 'string' ? Date.parse(endRaw) : Number.NaN
    const at = Number.isNaN(parsed) ? this.clock().getTime() : parsed
    this.transcriptSeq += 1
    return { seq: this.transcriptSeq, source: p.source as CaptureSource, text: p.text, at }
  }

  /**
   * Derive the Now context from the live session + hydrated data. The topic is the most recent moment
   * (the live pulse of the session); nothing is invented — with no session the panel is a quiet, dead
   * heartbeat, which is the honest empty state.
   */
  private buildNow(): NowContext {
    const session = this.session
    const context: NowContext = { live: session !== undefined && session.endedAt === undefined }
    if (session) {
      // #226: the workspace chip is disambiguation copy, not a name. The lone DEFAULT workspace ('default',
      // the config sentinel) needs none — showing its raw id read as machinery ("default /"), so omit it. A
      // user who runs an explicitly-named workspace still sees that label. Never render a raw id as a name.
      if (session.workspaceId !== 'default' && session.workspaceId.trim() !== '') context.workspace = session.workspaceId
      // #211: name the episode. A derived/user title lands on session.title (resolved server-side); until one
      // exists, an honest start-time fallback stands in — never a raw id, never a machine placeholder.
      context.title = session.title !== undefined && session.title.trim() !== '' ? session.title : `started ${clockLabel(session.startedAt)}`
      context.elapsed = `${clockLabel(session.startedAt)} · ${elapsedLabel(session.startedAt, this.clock())}`
    }
    const topic = this.latestMomentText()
    if (topic !== undefined) context.topic = topic
    return context
  }

  private latestMomentText(): string | undefined {
    for (let i = 0; i < (this.surface?.stack.length ?? 0); i += 1) {
      if (this.surface?.stack[i]?.query?.source !== 'moments') continue
      const items = (this.results[i]?.items ?? []) as Moment[]
      if (items[0]) return items[0].text
    }
    return undefined
  }
}
