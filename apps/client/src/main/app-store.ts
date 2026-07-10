import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { WindowPosition } from './window-position.js'

/**
 * The client-local state for the Apps folder + multi-window fleet (#19/#20/#98): which app surfaces are
 * FAVORITED, which were OPEN at last quit (so they reopen next launch), and each app window's remembered
 * POSITION keyed by surface id. Like the single-HUD `window-state.json` (window-store.ts), this is
 * CONFIG-not-a-flag — it is how the client paints its own windows, it never touches the engine or its
 * store (see PHASE2-NOTES). It lives in its OWN file (`apps-state.json`) so the long-standing default-HUD
 * position store stays exactly as it was; the pure (de)serialize/validate below round-trips headless.
 *
 * v0 scope: favorites/open-set/positions are persisted CLIENT-SIDE. On-surface-document favorites (a
 * favorite that follows the surface across machines) is a deliberate later choice — disclosed.
 */

export interface AppState {
  /** Surface ids the user favorited — float to the top of the Apps folder (#98). */
  favorites: string[]
  /** Surface ids with an app window open at last quit — reopened on next launch (#19 "persist open set"). */
  openApps: string[]
  /** Per-surface remembered window origin (top-left) — restored on reopen (#20). */
  positions: Record<string, WindowPosition>
}

const EMPTY: AppState = { favorites: [], openApps: [], positions: {} }

/** A fresh empty state (never the shared EMPTY, so callers can mutate their copy freely). */
export const emptyAppState = (): AppState => ({ favorites: [], openApps: [], positions: {} })

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

const asPosition = (v: unknown): WindowPosition | undefined => {
  if (typeof v !== 'object' || v === null) return undefined
  const { x, y } = v as Record<string, unknown>
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return undefined
  return { x: Math.round(x), y: Math.round(y) }
}

/**
 * Validate a parsed JSON blob into an AppState — pure, tolerant, never throws. Non-objects and wrong-typed
 * fields degrade to their empty/valid subset (a hand-edited file can never crash the shell), mirroring
 * parseClientConfigFile / parseWindowState. Duplicate ids are de-duped so the folder never doubles a row.
 */
export const parseAppState = (raw: unknown): AppState => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return emptyAppState()
  const r = raw as Record<string, unknown>
  const favorites = [...new Set(asStringArray(r['favorites']))]
  const openApps = [...new Set(asStringArray(r['openApps']))]
  const positions: Record<string, WindowPosition> = {}
  const rawPositions = r['positions']
  if (typeof rawPositions === 'object' && rawPositions !== null && !Array.isArray(rawPositions)) {
    for (const [id, value] of Object.entries(rawPositions as Record<string, unknown>)) {
      const pos = asPosition(value)
      if (pos) positions[id] = pos
    }
  }
  return { favorites, openApps, positions }
}

export const serializeAppState = (state: AppState): string =>
  JSON.stringify({
    favorites: [...new Set(state.favorites)],
    openApps: [...new Set(state.openApps)],
    positions: state.positions,
  })

/** Flip a surface id's membership in a list (favorite toggle / open-set edit) — pure, returns a new array. */
export const toggleInList = (list: readonly string[], id: string): string[] =>
  list.includes(id) ? list.filter((x) => x !== id) : [...list, id]

/** The state file's path within a userData directory. */
export const appStatePath = (userDataDir: string): string => path.join(userDataDir, 'apps-state.json')

/** Read the app state, or a fresh empty one if there is none / it is unreadable / it is malformed. */
export const readAppState = (userDataDir: string): AppState => {
  try {
    return parseAppState(JSON.parse(readFileSync(appStatePath(userDataDir), 'utf8')))
  } catch {
    return emptyAppState() // no file yet (first run), or an unreadable one — treat as empty
  }
}

/** Persist the app state, creating the userData directory if needed. Best-effort: IO errors are logged, not thrown. */
export const writeAppState = (userDataDir: string, state: AppState): void => {
  try {
    mkdirSync(userDataDir, { recursive: true })
    writeFileSync(appStatePath(userDataDir), serializeAppState(state), 'utf8')
  } catch (err) {
    console.error('[shell] could not persist app state:', err)
  }
}

/** The shared empty sentinel — exported for tests asserting the first-run shape. */
export const EMPTY_APP_STATE: Readonly<AppState> = EMPTY
