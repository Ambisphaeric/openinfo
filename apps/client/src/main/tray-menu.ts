import type { ShellCommand } from './shortcuts.js'
import type { SenseStatus, SenseLevel } from './capture-status.js'
import { appsSubmenuItems, type AppsFolderState } from './app-catalog.js'

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
  /**
   * A capture start could NOT be completed (issue #41): the renderer never acknowledged the start after
   * retries, or it died / failed to load. Surfaced VISIBLY on the status line + tooltip so a dropped
   * start is never silent again (it used to log only to a lost stdout). Cleared once capture starts or
   * the session ends. A short, human reason — not a stack.
   */
  captureFault?: string | undefined
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
  /**
   * The engine version handshake line the shell captured at startup ("engine v0.0.1 · adopted at :8787",
   * "· spawned (bundled)", or a skew note when the adopted engine's version ≠ this app's). Shown as a
   * disabled info item so the user can SEE which engine they are on. Undefined when unreachable (the
   * status line already leads with that) or before the handshake resolves. See engine-supervisor.ts.
   */
  engineInfoLine?: string | undefined
  /**
   * The per-sense capture-permission readout (mic / screen / system-audio) the user can reach to DEBUG
   * capture — rendered as a "Capture status" submenu of honest state lines + one-click links to the
   * System Settings panes the OS won't popup for. Assembled by captureStatuses (capture-status.ts) from
   * state the main process already holds. Absent ⇒ no submenu (e.g. before the first paint).
   */
  captureStatus?: SenseStatus[]
  /**
   * The Apps folder (#19/#98): the app surfaces the engine serves, the user's favorites (floated to the
   * top), and which have a live window open right now. Rendered as an "Apps" submenu — the mini-apps
   * folder the user opens/focuses/closes windows from, and favorites from. Absent / no surfaces ⇒ no
   * Apps folder (e.g. before the surface list is fetched, or an engine that serves none).
   */
  apps?: AppsFolderState
}

export interface TrayMenuItem {
  /** stable id (for tests + click routing) */
  id: string
  /** 'separator' items have no label/command */
  type: 'normal' | 'separator' | 'header'
  label?: string
  command?: ShellCommand
  enabled?: boolean
  /** Nested items (a submenu) — used by the Capture-status readout. The shell maps this recursively. */
  submenu?: TrayMenuItem[]
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
  // A dropped/failed capture start is surfaced VISIBLY and takes priority over the warming-up state, so
  // the user is never left staring at "mic…" while nothing happens (issue #41).
  if (state.captureFault) return `● session live · ⚠ capture failed — ${state.captureFault}`
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
    if (state.captureFault) return `openinfo — session live (⚠ capture failed: ${state.captureFault})`
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

/** The status dot glyph for a sense's normalized level — granted lit, blocked warned, the rest quiet. */
export const senseDot = (level: SenseLevel): string =>
  level === 'granted' ? '●' : level === 'denied' ? '⚠' : level === 'unsupported' ? '·' : '○'

/** The Settings-pane fix-it command's label for a sense (only mic/screen have a pane to open). */
const senseFixLabel = (sense: SenseStatus['sense']): string =>
  sense === 'mic' ? 'Open Microphone settings…' : sense === 'screen' ? 'Open Screen Recording settings…' : 'Open Settings…'

/**
 * The "Capture status" submenu children: per sense a disabled state line + a disabled honest detail line,
 * and — when the OS needs a manual flip — an enabled item that opens the exact System Settings pane. This
 * is the debuggable readout ("the user should be able to debug here"): mic/screen/system-audio each read
 * plainly, and the flips macOS won't popup for (screen, a re-denied mic) are one click away.
 */
export const captureStatusItems = (statuses: SenseStatus[]): TrayMenuItem[] =>
  statuses.flatMap((s) => {
    const items: TrayMenuItem[] = [
      { id: `cap-${s.sense}`, type: 'header', label: `${senseDot(s.level)} ${s.label} — ${s.state}`, enabled: false },
      { id: `cap-${s.sense}-detail`, type: 'normal', label: `    ${s.detail}`, enabled: false },
    ]
    // The blocking-gate line (issue #7): when a gate BEYOND the OS-permission layer is what actually stops
    // this sense — the sense toggled off, engine unreachable, no session, or an engine-side processing gate
    // (distill/transcribe off, empty/failing stt-ocr endpoint) — name it here so the sense never reads as a
    // granted-but-silent "off". The OS-permission gate is skipped: the header + detail lines above already
    // say it (no redundant line), and its one-click fix is the fix-it item below.
    if (s.blocking && s.blocking.gate !== 'os-permission') {
      items.push({ id: `cap-${s.sense}-blocked`, type: 'normal', label: `    ⚠ blocked: ${s.blocking.reason}`, enabled: false })
      if (s.blocking.fix) items.push({ id: `cap-${s.sense}-blockfix`, type: 'normal', label: `    → ${s.blocking.fix}`, enabled: false })
    }
    if (s.fixCommand) items.push({ id: `cap-${s.sense}-fix`, type: 'normal', label: `    ${senseFixLabel(s.sense)}`, command: s.fixCommand, enabled: true })
    return items
  })

/**
 * Build the tray context menu as a declarative spec. One "toggle" item each for the window
 * (Show/Hide) and the session (Start/End); the session toggle is disabled until we've heard from
 * the engine, so the menu never lies about a state we haven't confirmed.
 */
export const buildTrayMenu = (state: TrayState): TrayMenuItem[] => {
  const items: TrayMenuItem[] = [
    { id: 'status', type: 'header', label: trayStatusLabel(state), enabled: false },
  ]
  // The engine version/disposition line, right under the status header — a disabled, at-a-glance
  // "which engine am I on?" affordance (skew made plain when the adopted engine differs from this app).
  if (state.engineInfoLine) {
    items.push({ id: 'engine-info', type: 'header', label: state.engineInfoLine, enabled: false })
  }
  items.push(
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
  )

  // The Apps folder (#19/#98) — the mini-apps window launcher, right under the window/session toggles.
  // Each app opens/focuses/closes its own window; favorites float to the top. Omitted until we know the
  // surface list (an engine that serves none, or before the first fetch) so the menu never shows an empty folder.
  if (state.apps && state.apps.surfaces.length > 0) {
    items.push(
      { id: 'sep-apps', type: 'separator' },
      { id: 'apps', type: 'normal', label: 'Apps', enabled: true, submenu: appsSubmenuItems(state.apps) },
    )
  }

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

  items.push({ id: 'sep-2', type: 'separator' })
  // The capture-status readout — a submenu the user opens to see, and debug, each sense's permission state.
  if (state.captureStatus && state.captureStatus.length > 0) {
    items.push({ id: 'capture-status', type: 'normal', label: 'Capture status', enabled: true, submenu: captureStatusItems(state.captureStatus) })
  }
  items.push(
    { id: 'open-setup', type: 'normal', label: setupItemLabel(state.needsModelSetup), command: 'open-setup', enabled: true },
    { id: 'sep-3', type: 'separator' },
    { id: 'quit', type: 'normal', label: 'Quit openinfo', command: 'quit', enabled: true },
  )
  return items
}
