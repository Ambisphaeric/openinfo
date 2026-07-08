import type { ShellCommand } from './shortcuts.js'

/**
 * The tray (menu-bar) state machine, pure so the whole thing — label flips, enabled state, the
 * live-session indicator, the tooltip — is asserted under node:test without a display or a real
 * Tray. The shell maps this spec into `Menu.buildFromTemplate` and dispatches `item.command`.
 *
 * Live-session state is reflected TWO ways: a disabled header item (● live / ○ idle) at the top of
 * the menu, and the tray tooltip. The founder asked for a menu-bar on/off toggle — Start Session /
 * End Session IS that toggle, and its label flips with the live state so one item does both jobs.
 */
export interface TrayState {
  /** Is the HUD window currently visible? (drives Show ⇄ Hide) */
  visible: boolean
  /** Is there a live (unended) session in the target workspace? (drives Start ⇄ End) */
  sessionLive: boolean
  /** True once the initial session state has been fetched — before that Start/End is disabled. */
  connected: boolean
  /** Has audio genuinely begun flowing? Shows the honest ● rec indicator (NOT on start intent). */
  capturing?: boolean
  /** Mic told to start but the first segment hasn't arrived yet — the honest "warming up" state. */
  micStarting?: boolean
  /** Was mic access refused? Shows a clear indication; the session/text path still works. */
  micBlocked?: boolean
  /**
   * Does the live fabric's llm slot have no endpoint? Then nothing can distill — the tray surfaces
   * "Set up models…" prominently (⚠) as the first-run onboarding nudge (see PHASE2-NOTES). Undefined
   * until the fabric has been fetched, so the item stays quiet rather than crying wolf before we know.
   */
  needsModelSetup?: boolean | undefined
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
 * The disabled status line at the top of the menu — the at-a-glance live indicator. When a session
 * is live it also reflects the mic: `● rec` while capturing (privacy-honest — you can always see the
 * mic is on) or `mic blocked` if access was refused (the session still runs, only audio is off).
 */
export const trayStatusLabel = (state: TrayState): string => {
  if (!state.connected) return '○ connecting…'
  if (!state.sessionLive) return '○ no session'
  if (state.micBlocked) return '● session live · mic blocked'
  if (state.capturing) return '● session live · ● rec'
  if (state.micStarting) return '● session live · ○ mic…'
  return '● session live'
}

/** The menu-bar tooltip — same signal, visible on hover without opening the menu. */
export const trayTooltip = (state: TrayState): string => {
  if (!state.sessionLive) return 'openinfo — idle'
  if (state.micBlocked) return 'openinfo — session live (mic blocked)'
  if (state.capturing) return 'openinfo — session live ● rec'
  if (state.micStarting) return 'openinfo — session live (mic starting…)'
  return 'openinfo — session live'
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
export const buildTrayMenu = (state: TrayState): TrayMenuItem[] => [
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
  { id: 'sep-2', type: 'separator' },
  {
    id: 'open-setup',
    type: 'normal',
    label: setupItemLabel(state.needsModelSetup),
    command: 'open-setup',
    enabled: true,
  },
  { id: 'sep-3', type: 'separator' },
  { id: 'quit', type: 'normal', label: 'Quit openinfo', command: 'quit', enabled: true },
]
