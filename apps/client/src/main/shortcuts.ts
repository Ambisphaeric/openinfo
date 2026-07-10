/**
 * Global shortcut → command mapping, kept as pure data so the binding is asserted without registering
 * a real OS shortcut (globalShortcut needs the app to be ready and a display). The shell registers
 * each accelerator with `globalShortcut.register` and dispatches the mapped command.
 *
 * ⌘\ is the inherited Glass toggle — the user asked for "hide the window the way Glass does". The
 * accelerator uses electron's cross-platform `CommandOrControl` token (⌘ on macOS, Ctrl elsewhere).
 */
/**
 * The shell's PARAMETERLESS command names — a fixed verb emitted by the tray menu and global shortcuts.
 * (The multi-window Apps folder adds PARAMETERIZED commands below; see ShellCommand.)
 */
export type ShellCommandName =
  | 'show-hud'
  | 'hide-hud'
  | 'toggle-visibility'
  | 'start-session'
  | 'end-session'
  | 'open-setup'
  | 'open-mic-settings'
  | 'open-accessibility-settings'
  | 'open-screen-settings'
  | 'quit'

/**
 * The parameterized app commands (mini-apps-in-a-folder, #19/#98). A tray "Apps" row carries the surface
 * id it acts on, so one command shape addresses N windows: `open-app` opens-or-focuses that surface's
 * window, `close-app` closes it, `toggle-favorite` flips its client-side favorite (favorites float to the
 * top of the Apps folder). This is the shape the parameterless ShellCommandName union could not express —
 * the substrate change #98 called out.
 */
export type AppCommand =
  | { kind: 'open-app'; surfaceId: string }
  | { kind: 'close-app'; surfaceId: string }
  | { kind: 'toggle-favorite'; surfaceId: string }

/** The shell's whole command vocabulary — a parameterless name OR a parameterized app command. */
export type ShellCommand = ShellCommandName | AppCommand

export const SHORTCUTS: ReadonlyArray<{ accelerator: string; command: ShellCommand }> = [
  { accelerator: 'CommandOrControl+\\', command: 'toggle-visibility' },
] as const
