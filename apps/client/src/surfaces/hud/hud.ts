import type { CaptureSource, Moment, QueryResult, Session, Surface } from '@openinfo/contracts'
import { renderSurface, clockLabel, elapsedLabel, type BlockRegistry, type NowContext, type VElement } from '../block-renderer/index.js'
import { defaultBlockRegistry } from '../blocks/index.js'
import { pruneTranscript, renderLiveTranscript, type TranscriptLine } from './live-transcript.js'
import type { HudTransport } from './transport.js'

const DEFAULT_SURFACE_ID = 'surf-openinfo-hud'

/**
 * Live-update strategy: which events invalidate the hydrated data (see PHASE2-NOTES — re-query).
 * 'ws.open' is synthesized by the transport whenever its event socket (re)connects — events during an
 * engine restart are missed, so a fresh socket re-hydrates once to catch up (coalesced; harmless on the
 * very first open, which lands right after start()'s own refresh).
 */
const REFRESH_EVENTS = new Set(['moment.created', 'entity.updated', 'distillate.updated', 'session.started', 'session.ended', 'ws.open'])

/** The ephemeral live-transcript fast-path event (#58) — PAYLOAD-fed, not a query-refresh trigger. */
const TRANSCRIPT_EVENT = 'transcript.updated'
/** Session boundaries reset the live feed — a new/ended session starts a fresh transcript. */
const TRANSCRIPT_RESET_EVENTS = new Set(['session.started', 'session.ended'])

export interface HudOptions {
  transport: HudTransport
  onRender: (panel: VElement) => void
  surfaceId?: string
  workspace?: string
  registry?: BlockRegistry
  /** injectable clock so the Now-line elapsed is testable */
  now?: () => Date
  /**
   * Called when an event-driven async operation (a WS-triggered refresh or surface reload) rejects.
   * Without it those rejections were unhandled and INVISIBLE — in a transparent window that reads as
   * "the HUD disappeared". The dev entry routes this into the boot controller's restart loop.
   */
  onError?: (error: unknown) => void
}

/**
 * The live HUD controller. It loads the surface DOCUMENT once, hydrates each block's query through the
 * engine, renders the panel via the (document-driven) block renderer, and re-renders on live WS events.
 *
 * Live updates are RE-QUERY, not patch-in-place (PHASE2-NOTES): the block query is the single source of
 * truth and the engine owns ranking/joining — patching rows client-side would duplicate that logic and
 * violate "the engine thinks, the block renders". A data event re-hydrates the block queries; a session
 * event also re-derives the Now line. Rapid events are coalesced so a burst causes one refresh.
 */
export class Hud {
  private readonly transport: HudTransport
  private readonly onRender: (panel: VElement) => void
  private readonly surfaceId: string
  private readonly workspace: string
  private readonly registry: BlockRegistry
  private readonly clock: () => Date

  private readonly onError: ((error: unknown) => void) | undefined

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
    this.clock = options.now ?? (() => new Date())
    this.onError = options.onError
  }

  /** Load the surface document, hydrate + render once, then start listening for live updates. */
  async start(): Promise<void> {
    this.surface = await this.transport.surface(this.surfaceId)
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
      // A session boundary starts a fresh live feed; fall through to the normal refresh below.
      if (TRANSCRIPT_RESET_EVENTS.has(event.name)) this.transcriptLines = []
      if (REFRESH_EVENTS.has(event.name)) this.scheduleRefresh().catch((err: unknown) => this.onError?.(err))
    })
  }

  /** Re-fetch the surface document (a layout edit), then re-hydrate + render through the coalescer. */
  async reloadSurface(): Promise<void> {
    this.surface = await this.transport.surface(this.surfaceId)
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

  /** Re-derive the live session and re-hydrate every block query, then render. */
  async refresh(): Promise<void> {
    if (!this.surface) return
    const [live, results] = await Promise.all([
      this.transport.sessions({ workspace: this.workspace, live: true }),
      Promise.all(this.surface.stack.map((block) => (block.query ? this.transport.query(block.query) : Promise.resolve(undefined)))),
    ])
    this.session = live[0]
    this.results = results
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
    const panel = renderSurface({ surface: this.surface, now, results: this.results, clarify }, this.registry)
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
      context.workspace = session.workspaceId
      if (session.title !== undefined) context.title = session.title
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
