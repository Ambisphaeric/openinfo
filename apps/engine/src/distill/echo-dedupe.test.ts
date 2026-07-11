import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EchoDedupe,
  echoDedupeEnabled,
  normalizeEchoText,
  ECHO_DEDUPE_BUFFER_MS,
  ECHO_DEDUPE_WINDOW_MS,
} from './echo-dedupe.js'

const base = Date.UTC(2026, 6, 10, 12, 0, 0)
const at = (offsetMs: number): string => new Date(base + offsetMs).toISOString()
const frag = (text: string, offsetMs: number, sessionId = 'ses-echo'): { sessionId: string; text: string; capturedAt: string } => ({
  sessionId,
  text,
  capturedAt: at(offsetMs),
})

test('normalizeEchoText: lowercases, strips punctuation, collapses whitespace', () => {
  assert.equal(normalizeEchoText("  Let's  MOVE the meeting—to   Tuesday!! "), 'let s move the meeting to tuesday')
  assert.equal(normalizeEchoText('...'), '')
})

test('isEcho: true at Jaccard >= 0.8 within the ±2000ms window', () => {
  const dedupe = new EchoDedupe()
  // 9 shared tokens, 1 unique per side: intersection 9 / union 11 ≈ 0.818 — above the bar, NOT containment.
  dedupe.observeSystem(frag('alpha bravo charlie delta echo foxtrot golf hotel india yankee', 0))
  assert.equal(dedupe.isEcho(frag('alpha bravo charlie delta echo foxtrot golf hotel india zulu', 1500)), true)
})

test('isEcho: false when the pair is outside the ±2000ms window', () => {
  const dedupe = new EchoDedupe()
  dedupe.observeSystem(frag('ship the release on thursday afternoon', 0))
  assert.equal(dedupe.isEcho(frag('ship the release on thursday afternoon', ECHO_DEDUPE_WINDOW_MS + 500)), false)
})

test('isEcho: false when token-set similarity is low', () => {
  const dedupe = new EchoDedupe()
  dedupe.observeSystem(frag('the quarterly numbers look strong overall', 0))
  assert.equal(dedupe.isEcho(frag('let me grab a coffee before we start', 500)), false)
})

test('containment is directional: mic ⊆ system drops, system ⊆ mic does NOT', () => {
  const dedupe = new EchoDedupe()
  dedupe.observeSystem(frag('okay so let us move the meeting to tuesday then', 0))
  // mic fragment fully contained in the system fragment (Jaccard well under 0.8) — bleed, dropped.
  assert.equal(dedupe.isEcho(frag('move the meeting to tuesday', 500)), true)
  // reverse: the system fragment is contained in a LONGER mic utterance (user speech + bleed) — kept.
  const reverse = new EchoDedupe()
  reverse.observeSystem(frag('move the meeting', 0, 'ses-rev'))
  assert.equal(reverse.isEcho(frag('i said we should move the meeting earlier maybe next week', 500, 'ses-rev')), false)
})

test('guard: mic fragments with < 3 unique tokens are never dropped, including "yeah yeah yeah"', () => {
  const dedupe = new EchoDedupe()
  dedupe.observeSystem(frag('yeah okay sounds good to me', 0))
  assert.equal(dedupe.isEcho(frag('yeah', 100)), false)
  assert.equal(dedupe.isEcho(frag('okay yeah', 100)), false)
  // 3 tokens but only 1 unique — still protected backchannel.
  assert.equal(dedupe.isEcho(frag('yeah yeah yeah', 100)), false)
})

test('buffer prunes entries older than 30s on insert', () => {
  // Control: without the pruning insert the mic twin matches.
  const control = new EchoDedupe()
  control.observeSystem(frag('we will ship the new build tonight', 0))
  assert.equal(control.isEcho(frag('we will ship the new build tonight', 1000)), true)
  // A later system insert past the horizon prunes the old entry; the same mic twin no longer matches
  // (its capturedAt is within ±2s of the PRUNED entry, so only the prune explains the miss).
  const pruned = new EchoDedupe()
  pruned.observeSystem(frag('we will ship the new build tonight', 0))
  pruned.observeSystem(frag('completely unrelated closing remarks here', ECHO_DEDUPE_BUFFER_MS + 1000))
  assert.equal(pruned.isEcho(frag('we will ship the new build tonight', 1000)), false)
})

test('kill-switch: OPENINFO_ECHO_DEDUPE=0 disables, anything else stays ON', () => {
  assert.equal(echoDedupeEnabled({}), true)
  assert.equal(echoDedupeEnabled({ OPENINFO_ECHO_DEDUPE: '1' }), true)
  assert.equal(echoDedupeEnabled({ OPENINFO_ECHO_DEDUPE: '0' }), false)
})

test('echoSuppressed counter increments per drop, per session', () => {
  const dedupe = new EchoDedupe()
  dedupe.observeSystem(frag('first duplicated system line here', 0))
  dedupe.observeSystem(frag('second duplicated system line here', 3000))
  assert.equal(dedupe.isEcho(frag('first duplicated system line here', 500)), true)
  assert.equal(dedupe.isEcho(frag('second duplicated system line here', 3500)), true)
  assert.equal(dedupe.suppressedCount('ses-echo'), 2)
  assert.equal(dedupe.suppressedCount('ses-other'), 0)
})
