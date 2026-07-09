/**
 * Permission fix-it plumbing — the deep links the tray opens to the exact macOS Settings pane a user
 * must visit, plus the LAN-engine classification behind the honest "check Local Network permission?"
 * hint. Pure (no electron), so the URL builders and the classification are asserted headless; the shell
 * (shell.ts) passes these to `shell.openExternal` and into the TrayState.
 *
 * WHY DEEP LINKS: an unsigned dev binary can't force the OS to re-present a denied TCC prompt, and a user
 * who clicked "Don't Allow" on the mic can only fix it in System Settings. So denial must be ACTIONABLE:
 * the tray item opens the precise pane rather than leaving the user to hunt. The `x-apple.systempreferences:`
 * scheme + a `Privacy_*` anchor is the documented macOS form and is verified to open the right pane on
 * this machine (macOS 26) in the slice's live run. If a future macOS renames an anchor the link degrades
 * to opening Settings at Privacy & Security (still the right neighbourhood), never a dead end.
 */

/** Microphone privacy pane — where a user re-grants mic access after a denial (the TCC prompt won't re-fire). */
export const MIC_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'

/**
 * Accessibility privacy pane — where the running app is granted Accessibility, which the focus poller's
 * `osascript`/System Events read of the frontmost window needs. (Honest note carried into the docs: some
 * apps additionally gate their WINDOW TITLES behind Screen Recording; Accessibility is the primary grant
 * and the reliable floor, so this is the pane the context-detection hint opens.)
 */
export const ACCESSIBILITY_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'

/**
 * Screen-Recording privacy pane — where a user enables screen capture. Unlike the mic there is NO
 * triggerable TCC popup for screen recording: the user must flip this toggle in System Settings and then
 * RELAUNCH openinfo before capture can grab frames (macOS returns empty images until then). So the
 * capture-status readout points here with honest "flip then relaunch" copy rather than pretending an
 * in-app prompt exists (see capture-status.ts).
 */
export const SCREEN_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'

/**
 * Local Network privacy pane — surfaced in DOCS (not the tray) for a LAN engine. We deliberately do NOT
 * ship a tray button that "fixes" Local Network: unlike mic/accessibility there is no reliable per-app
 * re-grant path from a denied state on all macOS versions, and we cannot QUERY Local Network TCC state to
 * know it's the cause (see the tooltip hint — it is phrased as a possibility, never a detection).
 */
export const LOCAL_NETWORK_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork'

/** The tray fix-it commands that map to a Settings deep link. */
export type SettingsLinkCommand = 'open-mic-settings' | 'open-accessibility-settings' | 'open-screen-settings'

/** Map a tray fix-it command to the Settings URL the shell should open. */
export const settingsUrlFor = (command: SettingsLinkCommand): string =>
  command === 'open-mic-settings'
    ? MIC_SETTINGS_URL
    : command === 'open-screen-settings'
      ? SCREEN_SETTINGS_URL
      : ACCESSIBILITY_SETTINGS_URL

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'])

/**
 * Is the configured engine on the LOCAL NETWORK (a non-loopback host), i.e. one whose first reach could
 * trip the macOS Local Network TCC gate? Loopback (localhost / 127.0.0.1 / ::1) ⇒ false; any other host
 * (a bare LAN IP, a `*.local` name, a remote box) ⇒ true. Used only to phrase the unreachable tooltip as
 * a HINT ("check Local Network permission?") — never as a claim that LN is the cause (we cannot detect that).
 */
export const isLanEngine = (engineUrl: string): boolean => {
  let host: string
  try {
    host = new URL(engineUrl).hostname.toLowerCase()
  } catch {
    return false // unparseable ⇒ don't invent a LAN hint
  }
  return host.length > 0 && !LOCAL_HOSTS.has(host)
}
