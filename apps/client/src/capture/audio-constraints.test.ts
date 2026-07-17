import { test } from 'node:test'
import assert from 'node:assert/strict'
import { micAudioConstraints, type SupportedAudioConstraints } from './audio-constraints.js'

/**
 * The mic constraint choice is the capture-side half of the loud-bleed fix (the renderer that applies it is
 * not CI-unit-tested, so the DECISION is pinned here). The invariants: echoCancellation stays ON, AGC is
 * pinned OFF (it was unset → Chromium default ON amplified bleed), and voiceIsolation is requested ONLY when
 * the runtime advertises it — never over-constraining a Chromium/Electron that lacks it.
 */

test('mic constraints: EC on, NS on, AGC off, mono — the always-set baseline', () => {
  const c = micAudioConstraints({})
  assert.equal(c.echoCancellation, true, 'echoCancellation stays ON (AEC subtracts the known far-end)')
  assert.equal(c.noiseSuppression, true)
  assert.equal(c.autoGainControl, false, 'AGC pinned OFF so it never amplifies quiet speaker bleed')
  assert.equal(c.channelCount, 1)
})

test('mic constraints: voiceIsolation IS requested when the runtime advertises support', () => {
  const supported: SupportedAudioConstraints = { echoCancellation: true, autoGainControl: true, voiceIsolation: true }
  assert.equal(micAudioConstraints(supported).voiceIsolation, true)
})

test('mic constraints: voiceIsolation is OMITTED when unsupported — capture never over-constrains', () => {
  // Older Chromium / OS without low-level voice isolation: the key is absent from getSupportedConstraints.
  assert.equal('voiceIsolation' in micAudioConstraints({ echoCancellation: true }), false)
  // And an undefined dictionary (a runtime with no getSupportedConstraints at all) is treated as unsupported.
  assert.equal('voiceIsolation' in micAudioConstraints(undefined), false)
})

test('mic constraints: AGC stays off even if the runtime would support AGC', () => {
  // getSupportedConstraints advertising autoGainControl must not flip our decision — we WANT it off.
  assert.equal(micAudioConstraints({ autoGainControl: true }).autoGainControl, false)
})
