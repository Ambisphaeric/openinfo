/**
 * Global shortcut → command mapping, kept as pure data so the binding is asserted without registering
 * a real OS shortcut (globalShortcut needs the app to be ready and a display). The shell registers
 * each accelerator with `globalShortcut.register` and dispatches the mapped command.
 *
 * ⌘\ is the inherited Glass toggle — the user asked for "hide the window the way Glass does". The
 * accelerator uses electron's cross-platform `CommandOrControl` token (⌘ on macOS, Ctrl elsewhere).
 */
/** The shell's command vocabulary — emitted by the tray menu and by global shortcuts. */
export type ShellCommand =
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

export const SHORTCUTS: ReadonlyArray<{ accelerator: string; command: ShellCommand }> = [
  { accelerator: 'CommandOrControl+\\', command: 'toggle-visibility' },
] as const
