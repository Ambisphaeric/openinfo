import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseFirstRunState, serializeFirstRunState, type FirstRunState } from './first-run.js'

/**
 * The thin IO edge for first-run state — a tiny `first-run.json` under Electron's `userData`, client-local
 * (never a flag document; whether onboarding has been shown is how the client remembers its own history,
 * it never reaches the engine or its store — the same config-not-flags line the shell/window slices drew).
 * The parse/serialize live pure in first-run.ts; here we only read/write, so a missing/bad file reads as
 * "never shown" rather than crashing the shell. `userDataDir` is injected (`app.getPath('userData')`) so
 * this round-trips in a headless test against a temp dir.
 */

/** The state file's path within a userData directory. */
export const firstRunStatePath = (userDataDir: string): string => path.join(userDataDir, 'first-run.json')

/** Read persisted first-run state, or `{}` (never shown) if there is none / it is unreadable / malformed. */
export const readFirstRunState = (userDataDir: string): FirstRunState => {
  try {
    return parseFirstRunState(JSON.parse(readFileSync(firstRunStatePath(userDataDir), 'utf8')))
  } catch {
    return {} // first run — no memory
  }
}

/** Persist a merged first-run state, best-effort (IO errors are logged, not thrown). */
const writeMerged = (userDataDir: string, patch: FirstRunState): void => {
  try {
    const next = { ...readFirstRunState(userDataDir), ...patch }
    mkdirSync(userDataDir, { recursive: true })
    writeFileSync(firstRunStatePath(userDataDir), serializeFirstRunState(next), 'utf8')
  } catch (err) {
    console.error('[shell] could not persist first-run state:', err)
  }
}

/** Record that /setup was auto-opened, at `at` — merged so a prior micPromptedAt is preserved. */
export const markFirstRunShown = (userDataDir: string, at: string): void => writeMerged(userDataDir, { firstRunShownAt: at })

/** Record that the first-launch mic prompt fired, at `at` — merged so firstRunShownAt is preserved. */
export const markMicPrompted = (userDataDir: string, at: string): void => writeMerged(userDataDir, { micPromptedAt: at })
