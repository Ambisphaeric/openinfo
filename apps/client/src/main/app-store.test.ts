import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  parseAppState,
  serializeAppState,
  toggleInList,
  readAppState,
  writeAppState,
  appStatePath,
  emptyAppState,
} from './app-store.js'

const scratch = (): string => mkdtempSync(path.join(tmpdir(), 'openinfo-appstate-'))

test('save then read round-trips favorites, open set, and per-surface positions', () => {
  const dir = scratch()
  const state = {
    favorites: ['surf-diag'],
    openApps: ['surf-glass-minimal'],
    positions: { 'surf-glass-minimal': { x: 120, y: 48 } },
  }
  writeAppState(dir, state)
  assert.deepEqual(readAppState(dir), state)
})

test('first run (no file) reads back an empty state, not a throw', () => {
  assert.deepEqual(readAppState(scratch()), emptyAppState())
})

test('a corrupt state file degrades to empty rather than crashing the shell', () => {
  const dir = scratch()
  writeFileSync(appStatePath(dir), '{ not json', 'utf8')
  assert.deepEqual(readAppState(dir), emptyAppState())
})

test('parse is tolerant: wrong-typed fields drop to their empty/valid subset', () => {
  assert.deepEqual(parseAppState(42), emptyAppState())
  assert.deepEqual(parseAppState(null), emptyAppState())
  assert.deepEqual(parseAppState([]), emptyAppState())
  // favorites with a non-string entry keeps only the strings; a bad position is dropped.
  const parsed = parseAppState({
    favorites: ['ok', 7, null],
    openApps: 'not-an-array',
    positions: { good: { x: 1, y: 2 }, bad: { x: 'nope', y: 2 }, alsoBad: 5 },
  })
  assert.deepEqual(parsed.favorites, ['ok'])
  assert.deepEqual(parsed.openApps, [])
  assert.deepEqual(parsed.positions, { good: { x: 1, y: 2 } })
})

test('parse de-dupes ids so the folder never doubles a row', () => {
  const parsed = parseAppState({ favorites: ['a', 'a', 'b'], openApps: ['x', 'x'] })
  assert.deepEqual(parsed.favorites, ['a', 'b'])
  assert.deepEqual(parsed.openApps, ['x'])
})

test('serialize rounds sub-pixel positions', () => {
  const out = JSON.parse(serializeAppState({ favorites: [], openApps: [], positions: { s: { x: 12.7, y: 40.2 } } }))
  // positions are stored as-given (already whole from parse), but a fresh sub-pixel goes through parse on read.
  assert.deepEqual(parseAppState(out).positions, { s: { x: 13, y: 40 } })
})

test('toggleInList adds then removes an id (favorite / open-set verb)', () => {
  assert.deepEqual(toggleInList([], 'a'), ['a'])
  assert.deepEqual(toggleInList(['a'], 'a'), [])
  assert.deepEqual(toggleInList(['a', 'b'], 'c'), ['a', 'b', 'c'])
  assert.deepEqual(toggleInList(['a', 'b'], 'a'), ['b'])
})
