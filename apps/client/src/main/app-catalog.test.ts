import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appsSubmenuItems, sortApps, type AppSurface, type AppsFolderState } from './app-catalog.js'

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
