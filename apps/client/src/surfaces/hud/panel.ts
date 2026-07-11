import type { AttachedPanel } from '@openinfo/contracts'

/**
 * The attached-expansion-panel geometry primitive (#134), renderer side. A surface whose document declares
 * a `panel` gets its window sized to a COLLAPSED or EXPANDED extent along one edge, and toggled between them
 * by the user OR — when `reveal:'event'` — by a matching bus event that opens it as a DISMISSIBLE SUGGESTION.
 *
 * Split like auto-resize.ts / window-drag.ts: the state machine + the size math are PURE and injected over a
 * tiny bridge, so the whole thing is asserted headless under node:test; the electron shell just applies the
 * reported content size (hud:panel-size → shell.ts → setContentSize). A panel surface installs THIS instead
 * of auto-resize — the panel owns its window extent (content beyond it scrolls), so nothing fights over height.
 */

/** The content-size delta a panel state maps to, along its edge's axis ONLY — the shell keeps the other axis. */
export interface PanelSize {
  width?: number
  height?: number
}

/**
 * The window extent for a panel state (PURE). `below` sizes HEIGHT (the below-HUD chat, ~3× its bar when
 * expanded); `right` sizes WIDTH (the collapsible sidebar). Only the edge axis is set — the orthogonal axis
 * stays whatever the window currently is, so the shell never has to know a base size.
 */
export const panelSize = (panel: AttachedPanel, expanded: boolean): PanelSize => {
  const extent = expanded ? panel.expanded : panel.collapsed
  return panel.edge === 'below' ? { height: extent } : { width: extent }
}

/**
 * Does an event name match a panel's `openOn` trigger (PURE + TOLERANT)? Matches an exact name OR a
 * `prefix.` prefix (so `openOn:'orientation.'` fires for `orientation.suggested`), and never throws on an
 * unset/empty trigger — a trigger event still being built in parallel (#131) is simply a no-op-until-present.
 */
export const matchesTrigger = (openOn: string | undefined, eventName: string): boolean => {
  if (openOn === undefined || openOn === '') return false
  if (eventName === openOn) return true
  return openOn.endsWith('.') && eventName.startsWith(openOn)
}

/** The bridge the controller drives — `apply` reports the target content size (electron: setContentSize). */
export interface PanelBridge {
  apply(size: PanelSize): void
}

/** A minimal event feed — the SAME shape hud.ts subscribes to (transport.subscribe). */
export interface PanelEventFeed {
  subscribe(handler: (event: { name: string; payload: unknown }) => void): () => void
}

export interface PanelState {
  expanded: boolean
  /** true ⇒ currently open BECAUSE an event suggested it (renders a dismiss affordance; never modal). */
  suggested: boolean
}

/**
 * The panel state machine. User verbs (expand/collapse/toggle) are authoritative and clear any suggestion.
 * `reveal:'event'` subscribes to the feed and, on a matching `openOn` event, OPENS AS A SUGGESTION exactly
 * once until dismissed — never auto-captures, never re-nags after the user dismisses it this session (the
 * clarify-dismiss precedent). Every state change re-applies the size over the bridge.
 */
export class PanelController {
  private readonly panel: AttachedPanel
  private readonly bridge: PanelBridge
  private readonly feed: PanelEventFeed | undefined
  private expanded: boolean
  private suggested = false
  private suggestionDismissed = false
  private unsubscribe: (() => void) | undefined

  constructor(panel: AttachedPanel, bridge: PanelBridge, feed?: PanelEventFeed) {
    this.panel = panel
    this.bridge = bridge
    this.feed = feed
    this.expanded = panel.startExpanded ?? false
  }

  /** Apply the initial extent and, for reveal:'event', begin listening for the trigger. */
  start(): void {
    this.apply()
    if (this.panel.reveal === 'event' && this.feed) {
      this.unsubscribe = this.feed.subscribe((event) => {
        if (matchesTrigger(this.panel.openOn, event.name)) this.suggestOpen()
      })
    }
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  state(): PanelState {
    return { expanded: this.expanded, suggested: this.suggested }
  }

  expand(): void {
    this.expanded = true
    this.suggested = false
    this.apply()
  }

  collapse(): void {
    this.expanded = false
    this.suggested = false
    this.apply()
  }

  toggle(): void {
    if (this.expanded) this.collapse()
    else this.expand()
  }

  /**
   * Open as a dismissible SUGGESTION (event-driven). No-op if already open or already dismissed this session
   * — a suggestion appears at most once and never nags, and never overrides a user who closed it.
   */
  suggestOpen(): void {
    if (this.expanded || this.suggested || this.suggestionDismissed) return
    this.expanded = true
    this.suggested = true
    this.apply()
  }

  /** Dismiss the suggestion ("not now") — collapses and suppresses further suggestions this session. */
  dismissSuggestion(): void {
    this.suggestionDismissed = true
    this.collapse()
  }

  private apply(): void {
    this.bridge.apply(panelSize(this.panel, this.expanded))
  }
}
