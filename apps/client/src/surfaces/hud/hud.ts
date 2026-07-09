import type { Moment, QueryResult, Session, Surface } from '@openinfo/contracts'
import { renderSurface, clockLabel, elapsedLabel, type BlockRegistry, type NowContext, type VElement } from '../block-renderer/index.js'
import { defaultBlockRegistry } from '../blocks/index.js'
import type { HudTransport } from './transport.js'

const DEFAULT_SURFACE_ID = 'surf-openinfo-hud'

/** Live-update strategy: which events invalidate the hydrated data (see PHASE2-NOTES — re-query). */
const REFRESH_EVENTS = new Set(['moment.created', 'entity.updated', 'distillate.updated', 'session.started', 'session.ended'])

export interface HudOptions {
  transport: HudTransport
  onRender: (panel: VElement) => void
  surfaceId?: string
  workspace?: string
  registry?: BlockRegistry
  /** injectable clock so the Now-line elapsed is testable */
  now?: () => Date
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

  private surface: Surface | undefined
  private results: (QueryResult | undefined)[] = []
  private session: Session | undefined
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
        if (payload && payload.id === this.surfaceId) void this.reloadSurface()
        return
      }
      if (REFRESH_EVENTS.has(event.name)) void this.scheduleRefresh()
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
    this.onRender(renderSurface({ surface: this.surface, now: this.buildNow(), results: this.results }, this.registry))
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
