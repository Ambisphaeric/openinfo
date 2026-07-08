import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk } from '@openinfo/contracts'
import { classifyKind, tallyFile, emptyByKind } from './kinds.js'

const chunk = (over: Partial<CaptureChunk>): CaptureChunk => ({
  id: 'c',
  sessionId: 's',
  workspaceId: 'default',
  source: 'mic',
  sequence: 1,
  capturedAt: '2026-07-08T14:00:00Z',
  contentType: 'text/plain',
  encoding: 'utf8',
  data: 'x',
  ...over,
})

test('classifyKind: mic and system-audio are audio', () => {
  assert.equal(classifyKind(chunk({ source: 'mic' })), 'audio')
  assert.equal(classifyKind(chunk({ source: 'system-audio', contentType: 'audio/wav', encoding: 'base64' })), 'audio')
})

test('classifyKind: screen/camera and image/* are screen (P4B lands here without importing P4B)', () => {
  assert.equal(classifyKind(chunk({ source: 'screen' })), 'screen')
  assert.equal(classifyKind(chunk({ source: 'camera' })), 'screen')
  assert.equal(classifyKind(chunk({ source: 'repo', contentType: 'image/png', encoding: 'base64' })), 'screen')
})

test('classifyKind: focus is excluded (its own kind, never a work backlog)', () => {
  assert.equal(classifyKind(chunk({ source: 'focus', contentType: 'application/json' })), 'focus')
})

test('classifyKind: text/calendar/repo default to llm-work', () => {
  assert.equal(classifyKind(chunk({ source: 'calendar', contentType: 'application/json' })), 'llm-work')
  assert.equal(classifyKind(chunk({ source: 'repo', contentType: 'text/plain' })), 'llm-work')
  assert.equal(classifyKind(chunk({ source: 'mic', contentType: 'text/plain' })), 'audio') // source wins for mic
})

test('tallyFile: apportions bytes per kind and excludes focus from work totals', () => {
  const chunks = [
    chunk({ source: 'mic' }),
    chunk({ source: 'system-audio', contentType: 'audio/wav', encoding: 'base64' }),
    chunk({ source: 'screen' }),
    chunk({ source: 'calendar', contentType: 'application/json' }),
    chunk({ source: 'focus', contentType: 'application/json' }),
  ]
  const by = tallyFile(chunks, 500) // 5 chunks → 100 bytes/chunk
  assert.equal(by.audio.pendingChunks, 2)
  assert.equal(by.audio.pendingBytes, 200)
  assert.equal(by.screen.pendingChunks, 1)
  assert.equal(by.screen.pendingBytes, 100)
  assert.equal(by['llm-work'].pendingChunks, 1)
  assert.equal(by['llm-work'].pendingBytes, 100)
  // focus (100 bytes) is NOT attributed — work-byte sum (400) < file bytes (500)
  const workBytes = by.audio.pendingBytes + by.screen.pendingBytes + by['llm-work'].pendingBytes
  assert.equal(workBytes, 400)
})

test('tallyFile: accumulates across files into the same ByKind', () => {
  const into = emptyByKind()
  tallyFile([chunk({ source: 'mic' })], 50, into)
  tallyFile([chunk({ source: 'mic' })], 50, into)
  assert.equal(into.audio.pendingChunks, 2)
  assert.equal(into.audio.pendingBytes, 100)
})

test('tallyFile: an empty or focus-only file contributes nothing', () => {
  assert.deepEqual(tallyFile([], 0), emptyByKind())
  const focusOnly = tallyFile([chunk({ source: 'focus', contentType: 'application/json' })], 80)
  assert.deepEqual(focusOnly, emptyByKind())
})
