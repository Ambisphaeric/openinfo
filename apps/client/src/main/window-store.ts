import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseWindowState, serializeWindowState, type WindowPosition } from './window-position.js'

/**
 * The thin IO edge for the remembered HUD position — the only place this slice touches the disk. It is
 * client-local state (a tiny JSON under Electron's `userData`), NOT a flag document: where a window sits
 * is how the client paints itself, it never reaches the engine or its store — the same config-not-flags
 * line the shell slice drew (see PHASE2-NOTES). The (de)serialize/validate logic lives pure in
 * window-position.ts; here we only read/write a file, so a bad or missing file is swallowed to
 * `undefined` (first run has no memory) rather than crashing the shell. `userDataDir` is injected
 * (`app.getPath('userData')` in the shell) so this round-trips in a headless test against a temp dir.
 */

/** The state file's path within a userData directory. */
export const windowStatePath = (userDataDir: string): string => path.join(userDataDir, 'window-state.json')

/** Read the remembered origin, or `undefined` if there is none / it is unreadable / it is malformed. */
export const readSavedPosition = (userDataDir: string): WindowPosition | undefined => {
  try {
    return parseWindowState(readFileSync(windowStatePath(userDataDir), 'utf8'))
  } catch {
    return undefined // no file yet (first run), or an unreadable one — treat as "no memory"
  }
}

/** Persist the origin, creating the userData directory if needed. Best-effort: IO errors are logged, not thrown. */
export const savePosition = (userDataDir: string, pos: WindowPosition): void => {
  try {
    mkdirSync(userDataDir, { recursive: true })
    writeFileSync(windowStatePath(userDataDir), serializeWindowState(pos), 'utf8')
  } catch (err) {
    console.error('[shell] could not persist HUD position:', err)
  }
}
