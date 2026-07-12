import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appsSubmenuItems, sortApps, type AppBundle, type AppSurface, type AppsFolderState } from './app-catalog.js'

const surfaces: AppSurface[] = [
  { id: 'surf-openinfo-hud', name: 'openinfo HUD' },
  { id: 'surf-glass-minimal', name: 'Glass Minimal' },
  { id: 'surf-diag', name: 'Diagnostics' },
]

const state = (over: Partial<AppsFolderState> = {}): AppsFolderState => ({
  surfaces,
  favorites: [],
  openIds: [],
  ...over,
})

const find = (items: ReturnType<typeof appsSubmenuItems>, id: string) => items.find((m) => m.id === id)

test('sortApps floats favorites to the top, then alphabetizes each group', () => {
  const sorted = sortApps(surfaces, ['surf-diag'])
  assert.deepEqual(
    sorted.map((s) => s.id),
    ['surf-diag', 'surf-glass-minimal', 'surf-openinfo-hud'], // favorite first; rest A→Z (Glass, openinfo)
  )
})

test('with no favorites the folder is purely alphabetical', () => {
  assert.deepEqual(
    sortApps(surfaces, []).map((s) => s.name),
    ['Diagnostics', 'Glass Minimal', 'openinfo HUD'],
  )
})

test('each app row carries open-or-focus, close, and favorite-toggle commands naming its surface id', () => {
  const items = appsSubmenuItems(state())
  const diag = find(items, 'app-surf-diag')
  assert.ok(diag?.submenu)
  const open = diag!.submenu!.find((m) => m.id === 'app-surf-diag-open')
  assert.deepEqual(open?.command, { kind: 'open-app', surfaceId: 'surf-diag' })
  const close = diag!.submenu!.find((m) => m.id === 'app-surf-diag-close')
  assert.deepEqual(close?.command, { kind: 'close-app', surfaceId: 'surf-diag' })
  const fav = diag!.submenu!.find((m) => m.id === 'app-surf-diag-fav')
  assert.deepEqual(fav?.command, { kind: 'toggle-favorite', surfaceId: 'surf-diag' })
})

test('an open app is marked ● and its Open reads "Focus"; Close is enabled only when open', () => {
  const items = appsSubmenuItems(state({ openIds: ['surf-diag'] }))
  const diag = find(items, 'app-surf-diag')
  assert.match(diag?.label ?? '', /^● /, 'open apps get the ● marker')
  assert.equal(diag!.submenu!.find((m) => m.id === 'app-surf-diag-open')?.label, 'Focus window')
  assert.equal(diag!.submenu!.find((m) => m.id === 'app-surf-diag-close')?.enabled, true)
  // A closed app: ○ marker, "Open", Close disabled.
  const glass = find(items, 'app-surf-glass-minimal')
  assert.match(glass?.label ?? '', /^○ /)
  assert.equal(glass!.submenu!.find((m) => m.id === 'app-surf-glass-minimal-open')?.label, 'Open window')
  assert.equal(glass!.submenu!.find((m) => m.id === 'app-surf-glass-minimal-close')?.enabled, false)
})

test('a favorite is marked ★ and its toggle reads "Remove from favorites"', () => {
  const items = appsSubmenuItems(state({ favorites: ['surf-diag'] }))
  const diag = find(items, 'app-surf-diag')
  assert.match(diag?.label ?? '', /★/)
  assert.equal(diag!.submenu!.find((m) => m.id === 'app-surf-diag-fav')?.label, 'Remove from favorites')
  // A non-favorite reads "Add to favorites".
  const glass = find(items, 'app-surf-glass-minimal')
  assert.doesNotMatch(glass?.label ?? '', /★/)
  assert.equal(glass!.submenu!.find((m) => m.id === 'app-surf-glass-minimal-fav')?.label, 'Add to favorites')
})

test('an empty surface list yields no rows (the shell then omits the Apps folder)', () => {
  assert.deepEqual(appsSubmenuItems(state({ surfaces: [] })), [])
})

// bundle-as-runtime-object: a bundle renders as ONE parent app whose faces open the mapped surfaces; a
// surface NOT claimed by a bundle face is demoted to a standalone catalog row.
const standardApp: AppBundle = {
  id: 'bundle-standard-app',
  name: 'Standard App',
  faces: [
    { kind: 'hud', surfaceRef: 'surf-openinfo-hud' },
    { kind: 'chat', surfaceRef: 'surf-openinfo-chat' },
    { kind: 'support', surfaceRef: 'surf-diag' },
  ],
}

const bundleSurfaces: AppSurface[] = [
  { id: 'surf-openinfo-hud', name: 'openinfo HUD' },
  { id: 'surf-openinfo-chat', name: 'Chat' },
  { id: 'surf-diag', name: 'Diagnostics' },
  { id: 'surf-glass-minimal', name: 'Glass Minimal' }, // not in any bundle → demoted to a standalone row
]

test('a bundle renders as ONE app whose faces open the mapped surfaces', () => {
  const items = appsSubmenuItems(state({ surfaces: bundleSurfaces, bundles: [standardApp] }))
  const app = find(items, 'app-bundle-bundle-standard-app')
  assert.ok(app?.submenu, 'the bundle is one parent app with a faces submenu')
  assert.match(app!.label ?? '', /Standard App$/)
  // The faces are listed in declared order, labeled by the mapped surface's name.
  assert.deepEqual(app!.submenu!.map((f) => f.label), ['○ openinfo HUD', '○ Chat', '○ Diagnostics'])
  // A face opens/focuses the surface it maps to (open-app naming the surfaceRef) via the one window factory.
  const hud = app!.submenu!.find((f) => f.id === 'app-bundle-bundle-standard-app-surf-openinfo-hud')
  const open = hud!.submenu!.find((m) => m.id === 'app-bundle-bundle-standard-app-surf-openinfo-hud-open')
  assert.deepEqual(open?.command, { kind: 'open-app', surfaceId: 'surf-openinfo-hud' })
  const close = hud!.submenu!.find((m) => m.id === 'app-bundle-bundle-standard-app-surf-openinfo-hud-close')
  assert.deepEqual(close?.command, { kind: 'close-app', surfaceId: 'surf-openinfo-hud' })
})

test('a surface not claimed by any bundle face is demoted to a standalone catalog row', () => {
  const items = appsSubmenuItems(state({ surfaces: bundleSurfaces, bundles: [standardApp] }))
  // Glass Minimal is not a face of any bundle → still a standalone app row.
  assert.ok(find(items, 'app-surf-glass-minimal'), 'the unclaimed surface is a standalone app')
  // The claimed surfaces do NOT also appear as standalone rows (no duplication).
  assert.equal(find(items, 'app-surf-openinfo-hud'), undefined)
  assert.equal(find(items, 'app-surf-diag'), undefined)
})

test('a bundle whose face window is open is marked ●; the face marker reflects that surface', () => {
  const items = appsSubmenuItems(state({ surfaces: bundleSurfaces, bundles: [standardApp], openIds: ['surf-openinfo-chat'] }))
  const app = find(items, 'app-bundle-bundle-standard-app')
  assert.match(app?.label ?? '', /^● /, 'a bundle with any open face is marked ●')
  const chat = app!.submenu!.find((f) => f.id === 'app-bundle-bundle-standard-app-surf-openinfo-chat')
  assert.match(chat?.label ?? '', /^● /, 'the open face carries the ● marker')
  assert.equal(chat!.submenu!.find((m) => m.id.endsWith('-open'))?.label, 'Focus window')
  assert.equal(chat!.submenu!.find((m) => m.id.endsWith('-close'))?.enabled, true)
  // A closed face reads ○ / Open, Close disabled.
  const hud = app!.submenu!.find((f) => f.id === 'app-bundle-bundle-standard-app-surf-openinfo-hud')
  assert.match(hud?.label ?? '', /^○ /)
  assert.equal(hud!.submenu!.find((m) => m.id.endsWith('-close'))?.enabled, false)
})

test('a face label falls back to its title override, then the kind, when the surface is unknown', () => {
  const b: AppBundle = { id: 'b', name: 'B', faces: [{ kind: 'support', surfaceRef: 'surf-missing' }, { kind: 'hud', surfaceRef: 'surf-x', title: 'Pill' }] }
  const items = appsSubmenuItems(state({ surfaces: [], bundles: [b] }))
  const labels = find(items, 'app-bundle-b')!.submenu!.map((f) => f.label)
  assert.deepEqual(labels, ['○ Support', '○ Pill']) // unknown surface → kind label; title override wins
})
