import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readSavedPosition, savePosition, windowStatePath } from './window-store.js'

const scratch = (): string => mkdtempSync(path.join(tmpdir(), 'openinfo-winstore-'))

test('save then read round-trips the position through the disk', () => {
  const dir = scratch()
  savePosition(dir, { x: 420, y: 96 })
  assert.deepEqual(readSavedPosition(dir), { x: 420, y: 96 })
})

test('reading a directory with no state file yields undefined (first run)', () => {
  assert.equal(readSavedPosition(scratch()), undefined)
})

test('save creates the userData directory if it does not exist yet', () => {
  const dir = path.join(scratch(), 'nested', 'userData')
  savePosition(dir, { x: 10, y: 20 })
  assert.deepEqual(readSavedPosition(dir), { x: 10, y: 20 })
})

test('a corrupt state file reads back as undefined, not a throw', () => {
  const dir = scratch()
  writeFileSync(windowStatePath(dir), '{ not valid json', 'utf8')
  assert.equal(readSavedPosition(dir), undefined)
})
