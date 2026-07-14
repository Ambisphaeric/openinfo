import { test } from 'node:test'
import assert from 'node:assert/strict'
import { captureStatuses, EngineSenseGateCache, invalidatesEngineSenseGates, type CaptureStatusInput, type Sense, type SenseStatus } from './capture-status.js'

const base: CaptureStatusInput = { platform: 'darwin', sysAudio: 'unknown', screenEnabled: false }
const run = (over: Partial<CaptureStatusInput> = {}): SenseStatus[] => captureStatuses({ ...base, ...over })
const bySense = (statuses: SenseStatus[], sense: Sense): SenseStatus => statuses.find((s) => s.sense === sense)!

test('the tray invalidates cached sense gates for flag, fabric, and active-workflow edits only', () => {
  for (const event of ['flag.changed', 'fabric.changed', 'workflow.updated']) {
    assert.equal(invalidatesEngineSenseGates(event), true, event)
  }
  for (const event of ['surface.updated', 'queue.updated', 'sense.lane.updated']) {
    assert.equal(invalidatesEngineSenseGates(event), false, event)
  }
})

test('sense-gate refresh clears stale truth and only the latest request may repopulate it', () => {
  const cache = new EngineSenseGateCache()
  const first = cache.begin()
  assert.equal(cache.succeed(first, [{ sense: 'screen', blocking: { id: 'old', label: 'old gate' } }]), true)
  assert.equal(cache.current()?.[0]?.blocking?.id, 'old')

  const slow = cache.begin()
  assert.equal(cache.current(), undefined, 'an invalidation removes stale engine truth immediately')
  const latest = cache.begin()
  assert.equal(cache.succeed(slow, [{ sense: 'screen', blocking: { id: 'stale', label: 'stale gate' } }]), false)
  assert.equal(cache.current(), undefined)
  assert.equal(cache.succeed(latest, [{ sense: 'screen', blocking: { id: 'current', label: 'current gate' } }]), true)
  assert.equal(cache.current()?.[0]?.blocking?.id, 'current')

  const failed = cache.begin()
  assert.equal(cache.fail(failed), true)
  assert.equal(cache.current(), undefined, 'a failed refetch cannot retain a now-invalid verdict')
})

test('the readout always covers the three senses in display order', () => {
  assert.deepEqual(
    run().map((s) => s.sense),
    ['mic', 'screen', 'sys-audio'],
  )
})

test('mic maps each TCC state honestly; only a denial offers the Settings fix-it', () => {
  assert.equal(bySense(run({ micAccess: 'granted' }), 'mic').level, 'granted')
  assert.equal(bySense(run({ micAccess: 'granted' }), 'mic').fixCommand, undefined)

  const denied = bySense(run({ micAccess: 'denied' }), 'mic')
  assert.equal(denied.level, 'denied')
  assert.equal(denied.fixCommand, 'open-mic-settings')
  assert.match(denied.detail, /Microphone/)

  const nd = bySense(run({ micAccess: 'not-determined' }), 'mic')
  assert.equal(nd.level, 'not-determined')
  assert.equal(nd.fixCommand, undefined) // the OS will popup — no manual flip needed
  assert.match(nd.state, /not yet asked/)

  // restricted reads as blocked (same flip needed as denied).
  assert.equal(bySense(run({ micAccess: 'restricted' }), 'mic').level, 'denied')
})

test('screen never claims an in-app prompt: non-granted states point at Screen Recording + say RELAUNCH', () => {
  const nd = bySense(run({ screenAccess: 'not-determined' }), 'screen')
  assert.equal(nd.fixCommand, 'open-screen-settings')
  assert.match(nd.detail, /RELAUNCH/)
  assert.match(nd.detail, /no in-app prompt/i)

  const denied = bySense(run({ screenAccess: 'denied' }), 'screen')
  assert.equal(denied.fixCommand, 'open-screen-settings')
  assert.match(denied.detail, /RELAUNCH/)
})

test('screen shows the enable path: granted-but-off names the opt-in config; off is called out', () => {
  const grantedOff = bySense(run({ screenAccess: 'granted', screenEnabled: false }), 'screen')
  assert.equal(grantedOff.level, 'granted')
  assert.match(grantedOff.state, /capture off/)
  assert.match(grantedOff.detail, /screenEnabled/)

  const grantedOn = bySense(run({ screenAccess: 'granted', screenEnabled: true }), 'screen')
  assert.equal(grantedOn.state, 'granted')
  assert.doesNotMatch(grantedOn.detail, /off by default/)

  // The opt-in note also rides the not-granted line so the enable path is always visible.
  assert.match(bySense(run({ screenAccess: 'not-determined', screenEnabled: false }), 'screen').detail, /off by default/)
})

test('system-audio is device presence, not a permission — missing-device points at a loopback device', () => {
  const missing = bySense(run({ sysAudio: 'missing-device' }), 'sys-audio')
  assert.equal(missing.level, 'missing-device')
  assert.equal(missing.fixCommand, undefined) // nothing the OS Settings can fix — you install a device
  assert.match(missing.detail, /BlackHole-class|loopback/)

  const present = bySense(run({ sysAudio: 'present' }), 'sys-audio')
  assert.equal(present.level, 'granted')
  assert.match(present.detail, /Microphone grant/)

  const unknown = bySense(run({ sysAudio: 'unknown' }), 'sys-audio')
  assert.equal(unknown.level, 'not-determined')
})

test('system-audio LOOPBACK method names the recording grant + one-click Settings fix, not a device install (#142)', () => {
  const missing = bySense(run({ sysAudio: 'missing-device', systemAudioMethod: 'loopback' }), 'sys-audio')
  assert.equal(missing.level, 'missing-device')
  assert.equal(missing.state, 'not available')
  // Loopback failing IS a one-click OS fix (grant Screen & System Audio Recording), unlike the device path.
  assert.equal(missing.fixCommand, 'open-screen-settings')
  assert.match(missing.detail, /Recording|relaunch|RELAUNCH/i)
  assert.match(missing.detail, /systemAudioMethod=device/) // honest downgrade path is named

  const present = bySense(run({ sysAudio: 'present', systemAudioMethod: 'loopback' }), 'sys-audio')
  assert.equal(present.level, 'granted')
  assert.match(present.detail, /no virtual device|no routing/i) // the no-setup win is stated
  assert.doesNotMatch(present.detail, /Microphone grant/) // loopback rides the recording grant, not the mic one
})

test('system-audio LOOPBACK missing is an actionable OS-layer block carrying the Settings fix command (#142)', () => {
  const missing = bySense(
    run({ sysAudio: 'missing-device', systemAudioMethod: 'loopback', engineReachable: true, sessionLive: true }),
    'sys-audio',
  )
  assert.equal(missing.blocking?.gate, 'os-permission')
  assert.equal(missing.blocking?.fixCommand, 'open-screen-settings')
})

test('off macOS the media senses read as unsupported (no false TCC claims)', () => {
  const linux = run({ platform: 'linux' }) // micAccess/screenAccess omitted (undefined) as the shell does off-darwin
  assert.equal(bySense(linux, 'mic').level, 'unsupported')
  assert.equal(bySense(linux, 'screen').level, 'unsupported')
  assert.equal(bySense(linux, 'mic').fixCommand, undefined)
})

// --- issue #7: the end-to-end blocking-gate chain --------------------------------------------------
// A "clear" baseline for the audio path: mic granted, session live, engine reachable, no engine gate.
const clearAudio = { micAccess: 'granted' as const, engineReachable: true, sessionLive: true }

test('sense toggled off is the first gate — named, never a bare silence', () => {
  const mic = bySense(run({ ...clearAudio, micEnabled: false }), 'mic')
  assert.equal(mic.blocking?.gate, 'sense-off')
  assert.match(mic.blocking!.reason, /Microphone is turned off/)
  assert.match(mic.blocking!.fix!, /OPENINFO_MIC/)
})

test('OS permission is the gate when granted-config but the OS blocks; carries the Settings fix command', () => {
  const mic = bySense(run({ micAccess: 'denied', engineReachable: true, sessionLive: true }), 'mic')
  assert.equal(mic.blocking?.gate, 'os-permission')
  assert.equal(mic.blocking?.fixCommand, 'open-mic-settings')
})

test('engine unreachable is the gate once the OS layer is clear', () => {
  const mic = bySense(run({ micAccess: 'granted', engineReachable: false, sessionLive: true }), 'mic')
  assert.equal(mic.blocking?.gate, 'engine-unreachable')
  assert.match(mic.blocking!.fix!, /engine/i)
})

test('no live session is the gate once engine is reachable', () => {
  const mic = bySense(run({ micAccess: 'granted', engineReachable: true, sessionLive: false }), 'mic')
  assert.equal(mic.blocking?.gate, 'no-session')
  assert.match(mic.blocking!.fix!, /Start a session/)
})

test('the engine-side verdict is chained LAST — its gate id + fix pass through verbatim', () => {
  const engineGates = [{ sense: 'mic' as const, blocking: { id: 'distill.transcribe', label: 'Transcribe audio', fix: 'Enable distill.transcribe' } }]
  const mic = bySense(run({ ...clearAudio, engineGates }), 'mic')
  assert.equal(mic.blocking?.gate, 'distill.transcribe')
  assert.equal(mic.blocking?.reason, 'Transcribe audio')
  assert.equal(mic.blocking?.fix, 'Enable distill.transcribe')
})

test('precedence: a client gate ALWAYS wins over the engine verdict (sense-off beats distill.transcribe)', () => {
  const engineGates = [{ sense: 'mic' as const, blocking: { id: 'distill.transcribe', label: 'Transcribe audio' } }]
  const mic = bySense(run({ ...clearAudio, micEnabled: false, engineGates }), 'mic')
  assert.equal(mic.blocking?.gate, 'sense-off') // the earliest closed gate is the named blocker
})

test('fully clear ⇒ no blocking gate (a sense that will actually produce output reads clean)', () => {
  const engineGates = [{ sense: 'mic' as const }] // engine reports the sense clear
  const mic = bySense(run({ ...clearAudio, micEnabled: true, engineGates }), 'mic')
  assert.equal(mic.blocking, undefined)
})

test('unknown client state is not asserted as a block (engineReachable/sessionLive undefined ⇒ skipped)', () => {
  // Only OS state known (granted), everything else undefined — no false "unreachable"/"no session" claim.
  const mic = bySense(run({ micAccess: 'granted' }), 'mic')
  assert.equal(mic.blocking, undefined)
})

test('system-audio: a missing loopback device is the OS-layer block; present + clear reads clean', () => {
  const missing = bySense(run({ sysAudio: 'missing-device', engineReachable: true, sessionLive: true }), 'sys-audio')
  assert.equal(missing.blocking?.gate, 'os-permission')

  const present = bySense(run({ sysAudio: 'present', engineReachable: true, sessionLive: true }), 'sys-audio')
  assert.equal(present.blocking, undefined)
})
