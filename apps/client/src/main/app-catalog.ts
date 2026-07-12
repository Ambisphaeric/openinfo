import type { TrayMenuItem } from './tray-menu.js'

/**
 * The "Apps" folder builder (#98 + bundle-as-runtime-object) — pure so the whole menu spec (sort order,
 * markers, per-app / per-face commands) is asserted headless, exactly like tray-menu.ts and
 * captureStatusItems. The tray gains an Apps submenu; its shape follows the owner IA (2026-07-11):
 * "Apps > Standard App > HUD/Chat/Support faces. Other windows demote to the Apps catalog."
 *
 *   - Each app BUNDLE (GET /bundles) is ONE parent entry whose submenu lists its FACES; a face opens/
 *     focuses/closes the surface it maps to (open-app / close-app naming the face's surfaceRef).
 *   - Any surface NOT claimed by a bundle face is DEMOTED to a standalone app row (the pre-bundle #98
 *     behavior — open/focus/close + favorite), listed below the bundles.
 *
 * Every row carries a parameterized command (shortcuts.ts) naming a surface id, so ONE shape drives N
 * windows through the multi-window registry + the one window factory (per-surface titles come free).
 */

/** An app surface as the tray sees it — the id + display name from GET /layouts/surfaces (#98). */
export interface AppSurface {
  id: string
  name: string
}

/** One face of an app bundle as the tray sees it — its role + the surface it maps to (GET /bundles). */
export interface AppBundleFace {
  kind: 'hud' | 'chat' | 'support'
  surfaceRef: string
  /** Optional display override from the bundle; absent ⇒ the mapped surface's own name. */
  title?: string
}

/** An app bundle as the tray sees it — the id + display name + its ordered faces (GET /bundles). */
export interface AppBundle {
  id: string
  name: string
  faces: readonly AppBundleFace[]
}

export interface AppsFolderState {
  /** The app surfaces the engine serves (GET /layouts/surfaces). Empty ⇒ the Apps folder is omitted. */
  surfaces: readonly AppSurface[]
  /** Surface ids the user has favorited — they float to the top of the folder, marked ★ (client-side, #98). */
  favorites: readonly string[]
  /** Surface ids with a live open window right now — marked ● so the user sees what is running (#19). */
  openIds: readonly string[]
  /**
   * The app bundles the engine serves (GET /bundles). Each renders as ONE parent app whose faces open the
   * mapped surfaces. Absent/empty ⇒ every surface is listed flat (the pre-bundle #98 behavior, unchanged).
   */
  bundles?: readonly AppBundle[]
}

/** The at-a-glance glyph for an app/face row: ● open, else ○ (mirrors the tray's other status dots). */
const openDot = (open: boolean): string => (open ? '●' : '○')

const FACE_KIND_LABEL: Record<AppBundleFace['kind'], string> = { hud: 'HUD', chat: 'Chat', support: 'Support' }

/** A face's display name: its bundle title override, else the mapped surface's own name, else the kind. */
const faceLabel = (face: AppBundleFace, surfacesById: Map<string, AppSurface>): string =>
  face.title ?? surfacesById.get(face.surfaceRef)?.name ?? FACE_KIND_LABEL[face.kind]

/**
 * Order the standalone (unclaimed) apps: favorites first, then the rest, each group alphabetized by name
 * (case-insensitive, stable). Favorites floating to the top is the whole point of the favorite verb — a
 * power user running the same template for several repos pins the ones they move between.
 */
export const sortApps = (surfaces: readonly AppSurface[], favorites: readonly string[]): AppSurface[] => {
  const fav = new Set(favorites)
  return [...surfaces].sort((a, b) => {
    const favDelta = Number(fav.has(b.id)) - Number(fav.has(a.id))
    if (favDelta !== 0) return favDelta
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}

/** The Open/Focus + Close rows for ONE surface id — shared by standalone apps and bundle faces. */
const openCloseItems = (idPrefix: string, surfaceId: string, isOpen: boolean): TrayMenuItem[] => [
  {
    id: `${idPrefix}-open`,
    type: 'normal',
    label: isOpen ? 'Focus window' : 'Open window',
    command: { kind: 'open-app', surfaceId },
    enabled: true,
  },
  {
    id: `${idPrefix}-close`,
    type: 'normal',
    label: 'Close window',
    command: { kind: 'close-app', surfaceId },
    enabled: isOpen,
  },
]

/**
 * One BUNDLE parent entry: its name carries a ● marker when ANY face window is open; its submenu is one
 * entry per face (marker + face name), each a submenu of Open/Focus + Close naming the face's surfaceRef.
 * Face order is the bundle's declared order (hud first by convention). Ids are stable for click routing +
 * tests. Read-only: a face opens/focuses/closes the mapped surface — there is no bundle-editing affordance.
 */
const bundleItem = (bundle: AppBundle, open: Set<string>, surfacesById: Map<string, AppSurface>): TrayMenuItem => {
  const anyOpen = bundle.faces.some((f) => open.has(f.surfaceRef))
  const faces: TrayMenuItem[] = bundle.faces.map((face) => {
    const isOpen = open.has(face.surfaceRef)
    const idPrefix = `app-bundle-${bundle.id}-${face.surfaceRef}`
    return {
      id: idPrefix,
      type: 'normal',
      label: `${openDot(isOpen)} ${faceLabel(face, surfacesById)}`,
      enabled: true,
      submenu: openCloseItems(idPrefix, face.surfaceRef, isOpen),
    }
  })
  return { id: `app-bundle-${bundle.id}`, type: 'normal', label: `${openDot(anyOpen)} ${bundle.name}`, enabled: true, submenu: faces }
}

/**
 * One STANDALONE app entry (an unclaimed surface): its name carries the ★ favorite + ● open markers; its
 * submenu is Open/Focus, Close (enabled only when open), and the favorite toggle. The pre-bundle #98 shape.
 */
const standaloneItem = (app: AppSurface, open: Set<string>, fav: Set<string>): TrayMenuItem => {
  const isOpen = open.has(app.id)
  const isFav = fav.has(app.id)
  const label = `${openDot(isOpen)} ${isFav ? '★ ' : ''}${app.name}`
  const submenu: TrayMenuItem[] = [
    ...openCloseItems(`app-${app.id}`, app.id, isOpen),
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
}

/**
 * The children of the "Apps" submenu: the bundles first (each ONE app whose faces open the mapped
 * surfaces), then the surfaces NOT claimed by any bundle face as standalone apps (demoted to the catalog,
 * #98 behavior). Bundles alphabetize by name; standalone apps sort favorites-first then A→Z. An empty
 * surface list AND no bundles yields `[]` (the shell then omits the Apps folder entirely).
 */
export const appsSubmenuItems = (state: AppsFolderState): TrayMenuItem[] => {
  const open = new Set(state.openIds)
  const fav = new Set(state.favorites)
  const bundles = state.bundles ?? []
  const surfacesById = new Map(state.surfaces.map((s) => [s.id, s]))
  const claimed = new Set(bundles.flatMap((b) => b.faces.map((f) => f.surfaceRef)))

  const items: TrayMenuItem[] = []
  for (const bundle of [...bundles].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))) {
    items.push(bundleItem(bundle, open, surfacesById))
  }
  const leftover = state.surfaces.filter((s) => !claimed.has(s.id))
  for (const app of sortApps(leftover, state.favorites)) {
    items.push(standaloneItem(app, open, fav))
  }
  return items
}
