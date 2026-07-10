import type { TrayMenuItem } from './tray-menu.js'

/**
 * The "Apps" folder builder (#98) — pure so the whole menu spec (sort order, markers, per-app commands)
 * is asserted headless, exactly like tray-menu.ts and captureStatusItems (its dynamic-submenu precedent).
 * The tray gains an Apps submenu listing every app surface the engine serves; favorites float to the top,
 * an open app shows a marker, and each app opens/focuses/closes its own window and can be (un)favorited.
 *
 * This is the menu path onto the multi-window registry (app-registry.ts): each row carries the
 * parameterized `open-app` / `close-app` / `toggle-favorite` command (shortcuts.ts) naming its surface id.
 */

/** An app surface as the tray sees it — the id + display name from GET /layouts/surfaces (#98). */
export interface AppSurface {
  id: string
  name: string
}

export interface AppsFolderState {
  /** The app surfaces the engine serves (GET /layouts/surfaces). Empty ⇒ the Apps folder is omitted. */
  surfaces: readonly AppSurface[]
  /** Surface ids the user has favorited — they float to the top of the folder, marked ★ (client-side, #98). */
  favorites: readonly string[]
  /** Surface ids with a live open window right now — marked ● so the user sees what is running (#19). */
  openIds: readonly string[]
}

/** The at-a-glance glyph for an app row: ● open, else ○ (mirrors the tray's other status dots). */
const openDot = (open: boolean): string => (open ? '●' : '○')

/**
 * Order the folder: favorites first, then the rest, each group alphabetized by name (case-insensitive,
 * stable). Favorites floating to the top is the whole point of the favorite verb — a power user running
 * the same template for several repos pins the ones they move between.
 */
export const sortApps = (surfaces: readonly AppSurface[], favorites: readonly string[]): AppSurface[] => {
  const fav = new Set(favorites)
  return [...surfaces].sort((a, b) => {
    const favDelta = Number(fav.has(b.id)) - Number(fav.has(a.id))
    if (favDelta !== 0) return favDelta
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}

/**
 * The children of the "Apps" submenu: one submenu PER app (its name carries the ★ favorite + ● open
 * markers), whose items are the app's verbs — Open/Focus (open-or-focus is one command; the label
 * reflects whether it is already open), Close (enabled only when open), and the favorite toggle. Every
 * command names the surface id, so one shape drives N windows (#19/#98). Ids are stable for click routing
 * and tests. An empty surface list yields `[]` (the shell then omits the Apps folder entirely).
 */
export const appsSubmenuItems = (state: AppsFolderState): TrayMenuItem[] => {
  const fav = new Set(state.favorites)
  const open = new Set(state.openIds)
  return sortApps(state.surfaces, state.favorites).map((app) => {
    const isOpen = open.has(app.id)
    const isFav = fav.has(app.id)
    const label = `${openDot(isOpen)} ${isFav ? '★ ' : ''}${app.name}`
    const submenu: TrayMenuItem[] = [
      {
        id: `app-${app.id}-open`,
        type: 'normal',
        label: isOpen ? 'Focus window' : 'Open window',
        command: { kind: 'open-app', surfaceId: app.id },
        enabled: true,
      },
      {
        id: `app-${app.id}-close`,
        type: 'normal',
        label: 'Close window',
        command: { kind: 'close-app', surfaceId: app.id },
        enabled: isOpen,
      },
      { id: `app-${app.id}-sep`, type: 'separator' },
      {
        id: `app-${app.id}-fav`,
        type: 'normal',
        label: isFav ? 'Remove from favorites' : 'Add to favorites',
        command: { kind: 'toggle-favorite', surfaceId: app.id },
        enabled: true,
      },
    ]
    return { id: `app-${app.id}`, type: 'normal', label, enabled: true, submenu }
  })
}
