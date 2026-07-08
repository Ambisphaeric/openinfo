import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchSystemAudioDevice, SYSTEM_AUDIO_PATTERNS, type AudioDevice } from './device-match.js'

const dev = (over: Partial<AudioDevice> = {}): AudioDevice => ({ kind: 'audioinput', label: '', deviceId: 'id', ...over })

test('finds a BlackHole input by name (the v0 target), case-insensitively', () => {
  const devices = [
    dev({ label: 'MacBook Pro Microphone (Built-in)', deviceId: 'mic-1' }),
    dev({ label: 'BlackHole 2ch (Virtual)', deviceId: 'bh-1' }),
  ]
  assert.equal(matchSystemAudioDevice(devices)?.deviceId, 'bh-1')
  assert.equal(matchSystemAudioDevice([dev({ label: 'blackhole 16ch', deviceId: 'bh-2' })])?.deviceId, 'bh-2')
})

test('returns undefined when no virtual audio input is present (mic-only fallback)', () => {
  const devices = [dev({ label: 'MacBook Pro Microphone (Built-in)', deviceId: 'mic-1' })]
  assert.equal(matchSystemAudioDevice(devices), undefined)
})

test('ignores non-audioinput devices and unlabelled/id-less entries', () => {
  const devices = [
    dev({ kind: 'audiooutput', label: 'BlackHole 2ch', deviceId: 'out-1' }), // an OUTPUT, not what we capture
    dev({ kind: 'videoinput', label: 'BlackHole cam?', deviceId: 'cam-1' }),
    dev({ kind: 'audioinput', label: 'BlackHole 2ch', deviceId: '' }), // no usable id (pre-permission)
  ]
  assert.equal(matchSystemAudioDevice(devices), undefined) // none is a capturable audioinput with an id
})

test('honors pattern preference order, then device order within a pattern', () => {
  // A BlackHole (pattern[0]) beats a Loopback Audio (later pattern) regardless of enumeration order.
  const devices = [
    dev({ label: 'Loopback Audio', deviceId: 'lb-1' }),
    dev({ label: 'BlackHole 2ch', deviceId: 'bh-1' }),
  ]
  assert.equal(matchSystemAudioDevice(devices)?.deviceId, 'bh-1')
  // Two of the same pattern → first in device order wins (deterministic).
  const two = [dev({ label: 'BlackHole 2ch', deviceId: 'bh-a' }), dev({ label: 'BlackHole 16ch', deviceId: 'bh-b' })]
  assert.equal(matchSystemAudioDevice(two)?.deviceId, 'bh-a')
})

test('the pattern list is a non-empty, all-lowercase ordered constant (matcher lowercases labels)', () => {
  assert.ok(SYSTEM_AUDIO_PATTERNS.length > 0)
  assert.equal(SYSTEM_AUDIO_PATTERNS[0], 'blackhole') // best-known first
  assert.deepEqual(SYSTEM_AUDIO_PATTERNS, SYSTEM_AUDIO_PATTERNS.map((p) => p.toLowerCase()))
})
