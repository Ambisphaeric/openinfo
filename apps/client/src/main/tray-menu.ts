import type { ShellCommand } from './shortcuts.js'

/**
 * The tray (menu-bar) state machine, pure so the whole thing — label flips, enabled state, the
 * live-session indicator, the tooltip — is asserted under node:test without a display or a real
 * Tray. The shell maps this spec into `Menu.buildFromTemplate` and dispatches `item.command`.
 *
 * Live-session state is reflected TWO ways: a disabled header item (● live / ○ idle) at the top of
 * the menu, and the tray tooltip. The user asked for a menu-bar on/off toggle — Start Session /
 * End Session IS that toggle, and its label flips with the live state so one item does both jobs.
 */
export interface TrayState {
  /** Is the HUD window currently visible? (drives Show ⇄ Hide) */
  visible: boolean
  /** Is there a live (unended) session in the target workspace? (drives Start ⇄ End) */
  sessionLive: boolean
  /** True once the initial session state has been fetched — before that Start/End is disabled. */
  connected: boolean
  /**
   * Has the shell ATTEMPTED to reach the engine yet? Distinguishes the honest first-boot "○ connecting…"
   * (not yet tried) from "⚠ engine unreachable" (tried and failed) — the leading state when the engine
   * isn't running at launch. False until the first seed attempt resolves.
   */
  engineTried?: boolean
  /** The engine URL the shell tried — shown in the unreachable state so the user sees what it aimed at. */
  engineUrl?: string
  /**
   * Is the configured engine on the LOCAL NETWORK (non-loopback)? When it is unreachable, the tooltip
   * appends an honest "check Local Network permission?" HINT — a possibility, never a detection (we
   * cannot query Local Network TCC state). Loopback engines never get the hint. See permission-help.ts.
   */
  lanEngine?: boolean
  /**
   * Is context detection ON but not yielding usable window context (route.detect on, focus polling, but
   * no window title ever seen)? Shows the "Grant Accessibility…" fix-it item. See context-health.ts.
   */
  accessibilityHint?: boolean
  /** Has audio genuinely begun flowing? Shows the honest ● rec indicator (NOT on start intent). */
  capturing?: boolean
  /** Mic told to start but the first segment hasn't arrived yet — the honest "warming up" state. */
  micStarting?: boolean
  /** Was mic access refused? Shows a clear indication; the session/text path still works. */
  micBlocked?: boolean
  /** Is system audio (the far side — "them") genuinely being captured too? (drives "mic + system"). */
  systemCapturing?: boolean
  /**
   * Is the system-audio device present but delivering pure silence (nothing routed through it yet)? Shown
   * honestly as "system silent" rather than pretending to record — the user must route output through the
   * virtual device (or wear headphones). Only meaningful while `systemCapturing`.
   */
  systemSilent?: boolean
  /**
   * Does the live fabric's llm slot have no endpoint? Then nothing can distill — the tray surfaces
   * "Set up models…" prominently (⚠) as the first-run onboarding nudge (see PHASE2-NOTES). Undefined
   * until the fabric has been fetched, so the item stays quiet rather than crying wolf before we know.
   */
  needsModelSetup?: boolean | undefined
  /**
   * Is the client watching the foreground window for context (focus polling active — the engine's
   * `route.detect` flag is on AND the local opt-out isn't set)? Adds a quiet "· watching context"
   * note to the tooltip ONLY (privacy-honest: you can always see when context is being read), and it
   * is INDEPENDENT of a session (focus flows outside sessions — it is what starts them). Nothing when off.
   */
  watchingContext?: boolean
}

export interface TrayMenuItem {
  /** stable id (for tests + click routing) */
  id: string
  /** 'separator' items have no label/command */
  type: 'normal' | 'separator' | 'header'
  label?: string
  command?: ShellCommand
  enabled?: boolean
}

/**
 * Which sources the `● rec` indicator honestly covers, given the second (system-audio) stream:
 * `mic + system` when the far side is genuinely flowing, `mic; system silent` when the system-audio
 * device is present but nothing is routed through it (so we do NOT claim to record it), and `mic only`
 * when there is no system-audio device (or it isn't capturing). Only meaningful while the mic captures.
 */
export const recSourcesLabel = (state: TrayState): string => {
  if (!state.systemCapturing) return 'mic only'
  return state.systemSilent ? 'mic; system silent' : 'mic + system'
}

/**
 * The disabled status line at the top of the menu — the at-a-glance live indicator. When a session
 * is live it also reflects capture: `● rec (mic + system)` / `(mic only)` / `(mic; system silent)`
 * while capturing (privacy-honest — you can always see what is on) or `mic blocked` if access was
 * refused (the session still runs, only audio is off).
 */
export const trayStatusLabel = (state: TrayState): string => {
  if (!state.connected) {
    // Tried and failed ⇒ lead with the honest unreachable state + the URL it aimed at (no "start
    // engine" — that is out of scope). Not yet tried ⇒ the transient connecting state.
    if (state.engineTried) return state.engineUrl ? `⚠ engine unreachable — ${state.engineUrl}` : '⚠ engine unreachable'
    return '○ connecting…'
  }
  if (!state.sessionLive) return '○ no session'
  if (state.micBlocked) return '● session live · mic blocked'
  if (state.capturing) return `● session live · ● rec (${recSourcesLabel(state)})`
  if (state.micStarting) return '● session live · ○ mic…'
  return '● session live'
}

/**
 * The menu-bar tooltip — same session/capture signal, visible on hover without opening the menu, plus a
 * quiet "· watching context" note whenever focus polling is active (session or not — focus is what
 * starts sessions, so it runs independently). Nothing appended when context watching is off.
 */
export const trayTooltip = (state: TrayState): string => {
  const context = state.watchingContext ? ' · watching context' : ''
  const base = ((): string => {
    if (!state.connected) {
      if (!state.engineTried) return 'openinfo — connecting…'
      const url = state.engineUrl ? ` (${state.engineUrl})` : ''
      // LAN engines get an honest possibility, never a claim — we cannot detect Local Network TCC state.
      const lanHint = state.lanEngine ? ' — check Local Network permission?' : ''
      return `openinfo — engine unreachable${url}${lanHint}`
    }
    if (!state.sessionLive) return 'openinfo — idle'
    if (state.micBlocked) return 'openinfo — session live (mic blocked)'
    if (state.capturing) return `openinfo — session live ● rec (${recSourcesLabel(state)})`
    if (state.micStarting) return 'openinfo — session live (mic starting…)'
    return 'openinfo — session live'
  })()
  return `${base}${context}`
}

/**
 * The "Set up models…" tray item label. On first run (or any time the live fabric has no llm
 * endpoint) it is prefixed with ⚠ and reworded to a call to action — the tray IS the onboarding
 * nudge (no popups/notifications, per scope). Once an llm endpoint exists it is a plain, always-there
 * entry to the setup page. `undefined` (fabric not yet fetched) reads as "not prominent".
 */
export const setupItemLabel = (needsModelSetup: boolean | undefined): string =>
  needsModelSetup === true ? '⚠ Set up models…' : 'Set up models…'

/**
 * Build the tray context menu as a declarative spec. One "toggle" item each for the window
 * (Show/Hide) and the session (Start/End); the session toggle is disabled until we've heard from
 * the engine, so the menu never lies about a state we haven't confirmed.
 */
export const buildTrayMenu = (state: TrayState): TrayMenuItem[] => {
  const items: TrayMenuItem[] = [
    { id: 'status', type: 'header', label: trayStatusLabel(state), enabled: false },
    { id: 'sep-1', type: 'separator' },
    {
      id: 'toggle-window',
      type: 'normal',
      label: state.visible ? 'Hide HUD' : 'Show HUD',
      command: state.visible ? 'hide-hud' : 'show-hud',
      enabled: true,
    },
    {
      id: 'toggle-session',
      type: 'normal',
      label: state.sessionLive ? 'End Session' : 'Start Session',
      command: state.sessionLive ? 'end-session' : 'start-session',
      enabled: state.connected,
    },
  ]

  // Permission fix-its — shown ONLY in the state they fix, each opening the exact Settings pane. Denial
  // must be actionable (an unsigned dev app can't re-fire a denied TCC prompt): the user re-grants in
  // System Settings, and these items take them straight there.
  const fixits: TrayMenuItem[] = []
  if (state.micBlocked) {
    fixits.push({ id: 'fix-mic', type: 'normal', label: '⚠ Microphone blocked — Open Settings…', command: 'open-mic-settings', enabled: true })
  }
  if (state.accessibilityHint) {
    fixits.push({ id: 'fix-accessibility', type: 'normal', label: 'Grant Accessibility for context detection…', command: 'open-accessibility-settings', enabled: true })
  }
  if (fixits.length > 0) {
    items.push({ id: 'sep-fixits', type: 'separator' }, ...fixits)
  }

  items.push(
    { id: 'sep-2', type: 'separator' },
    { id: 'open-setup', type: 'normal', label: setupItemLabel(state.needsModelSetup), command: 'open-setup', enabled: true },
    { id: 'sep-3', type: 'separator' },
    { id: 'quit', type: 'normal', label: 'Quit openinfo', command: 'quit', enabled: true },
  )
  return items
}
