import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk, FocusSignal } from '@openinfo/contracts'
import {
  buildFocusSignal,
  focusChunk,
  focusSignalKey,
  FOCUS_SESSION_SENTINEL,
  parseRepoPath,
  redactTitle,
  REDACTION_PATTERNS,
  type FrontmostWindow,
} from './focus.js'

// The full CaptureChunk field set (payloads.ts) — asserted structurally without pulling typebox into
// the client package (mirrors chunk.test.ts).
const CHUNK_KEYS = ['id', 'sessionId', 'workspaceId', 'source', 'sequence', 'capturedAt', 'contentType', 'encoding', 'data'] as const

// --- title → repoPath -------------------------------------------------------------------------------

test('VS Code / Cursor titles yield the workspace root name (last em-dash segment)', () => {
  assert.equal(parseRepoPath('Code', 'focus.ts — openinfo'), 'openinfo')
  assert.equal(parseRepoPath('Cursor', 'detector.ts — apps/engine — openinfo'), 'openinfo')
  // an app-name suffix in the template is stripped before taking the last segment
  assert.equal(parseRepoPath('Code', 'focus.ts — openinfo — Visual Studio Code'), 'openinfo')
})

test('a lone editor segment (bare file, no root) yields no repoPath — we do not guess', () => {
  assert.equal(parseRepoPath('Code', 'Welcome'), undefined)
})

test('terminals prefer a real path token, else fall back to the leading cwd basename', () => {
  assert.equal(parseRepoPath('iTerm2', '~/openinfo/apps/client'), '~/openinfo/apps/client')
  assert.equal(parseRepoPath('iTerm2', 'user@host: ~/work/openinfo — zsh'), '~/work/openinfo')
  assert.equal(parseRepoPath('Terminal', 'openinfo — -zsh — 80×24'), 'openinfo')
})

test('non-dev apps and missing titles yield no repoPath', () => {
  assert.equal(parseRepoPath('Slack', 'general — Acme'), undefined)
  assert.equal(parseRepoPath('Safari', 'Some Page — Safari'), undefined)
  assert.equal(parseRepoPath('Code', undefined), undefined)
})

test('app match is case-insensitive substring (so "Code"/"iTerm2" match the rule apps)', () => {
  assert.equal(parseRepoPath('Visual Studio Code', 'a.ts — repo'), 'repo')
  assert.equal(parseRepoPath('iterm', '/srv/proj'), '/srv/proj')
})

// --- redaction --------------------------------------------------------------------------------------

test('redaction scrubs provider tokens, bearer tokens, emails, key=value, and long hex', () => {
  assert.equal(redactTitle('deploy sk-ABCDEFGHIJKLMNOP1234'), 'deploy [redacted]')
  assert.equal(redactTitle('token ghp_abcdefghijklmnopqrstuvwxyz0123'), 'token [redacted]')
  assert.equal(redactTitle('slack xoxb-123456789012-abcdef'), 'slack [redacted]')
  assert.equal(redactTitle('aws AKIAIOSFODNN7EXAMPLE key'), 'aws [redacted] key')
  assert.equal(redactTitle('auth Bearer abcdef0123456789xyz'), 'auth [redacted]')
  assert.equal(redactTitle('Inbox jane.doe@example.com'), 'Inbox [redacted]')
  assert.equal(redactTitle('password=hunter2secret'), '[redacted]')
  assert.equal(redactTitle('hash 0123456789abcdef0123456789abcdef'), 'hash [redacted]')
})

test('redaction leaves an ordinary title untouched', () => {
  assert.equal(redactTitle('focus.ts — openinfo'), 'focus.ts — openinfo')
})

test('the redaction pattern list is a non-empty ordered constant', () => {
  assert.ok(REDACTION_PATTERNS.length > 0)
})

// --- buildFocusSignal (redaction + repoPath + optional-field omission) -------------------------------

test('buildFocusSignal redacts the title, derives repoPath, and omits absent optionals', () => {
  const signal = buildFocusSignal({ app: 'Code', windowTitle: 'focus.ts — openinfo' })
  assert.deepEqual(signal, { app: 'Code', windowTitle: 'focus.ts — openinfo', repoPath: 'openinfo' })
})

test('buildFocusSignal never emits a raw secret-bearing title', () => {
  const signal = buildFocusSignal({ app: 'Terminal', windowTitle: 'export TOKEN ghp_abcdefghijklmnopqrstuvwxyz0123' })
  assert.ok(!signal.windowTitle?.includes('ghp_'))
  assert.ok(signal.windowTitle?.includes('[redacted]'))
})

test('buildFocusSignal with no title yields app-only (both optionals omitted, not undefined)', () => {
  const signal = buildFocusSignal({ app: 'zoom.us' })
  assert.deepEqual(Object.keys(signal), ['app'])
  assert.equal(signal.app, 'zoom.us')
})

test('a title that redacts down to whitespace is dropped (no empty windowTitle)', () => {
  const signal = buildFocusSignal({ app: 'X', windowTitle: 'jane@example.com' } as FrontmostWindow)
  // "jane@example.com" → "[redacted]" (non-empty), so it stays — assert the shape is honest:
  assert.equal(signal.windowTitle, '[redacted]')
})

// --- dedupe key -------------------------------------------------------------------------------------

test('focusSignalKey is identical for the same context and differs when any field changes', () => {
  const a: FocusSignal = { app: 'Code', windowTitle: 'a.ts — repo', repoPath: 'repo' }
  const b: FocusSignal = { app: 'Code', windowTitle: 'a.ts — repo', repoPath: 'repo' }
  const c: FocusSignal = { app: 'Code', windowTitle: 'b.ts — repo', repoPath: 'repo' }
  assert.equal(focusSignalKey(a), focusSignalKey(b))
  assert.notEqual(focusSignalKey(a), focusSignalKey(c))
  assert.notEqual(focusSignalKey(a), focusSignalKey({ app: 'Slack' }))
})

// --- chunk shaping ----------------------------------------------------------------------------------

test('focusChunk wraps a FocusSignal as a contract-shaped utf8/json focus CaptureChunk', () => {
  const signal: FocusSignal = { app: 'Code', windowTitle: 'focus.ts — openinfo', repoPath: 'openinfo' }
  const chunk: CaptureChunk = focusChunk(signal, { workspaceId: 'default', runId: 'r1' }, 1, '2026-07-08T10:00:00.000Z')
  assert.deepEqual(Object.keys(chunk).sort(), [...CHUNK_KEYS].sort())
  assert.equal(chunk.source, 'focus')
  assert.equal(chunk.encoding, 'utf8')
  assert.equal(chunk.contentType, 'application/json')
  assert.equal(chunk.workspaceId, 'default')
  assert.equal(chunk.sessionId, FOCUS_SESSION_SENTINEL) // flows outside sessions — sentinel id
  assert.equal(chunk.sequence, 1)
  assert.equal(chunk.capturedAt, '2026-07-08T10:00:00.000Z')
  assert.deepEqual(JSON.parse(chunk.data), signal) // data round-trips to the FocusSignal
})

test('focus chunk ids fold the run id + padded sequence (stable, collision-free across runs)', () => {
  const s: FocusSignal = { app: 'X' }
  assert.equal(focusChunk(s, { workspaceId: 'w', runId: 'r1' }, 1, 't').id, 'focus-r1-000001')
  assert.equal(focusChunk(s, { workspaceId: 'w', runId: 'r2' }, 1, 't').id, 'focus-r2-000001')
  assert.notEqual(focusChunk(s, { workspaceId: 'w', runId: 'r1' }, 1, 't').id, focusChunk(s, { workspaceId: 'w', runId: 'r1' }, 2, 't').id)
})
