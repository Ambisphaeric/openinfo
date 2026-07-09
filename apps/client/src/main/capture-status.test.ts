import { test } from 'node:test'
import assert from 'node:assert/strict'
import { captureStatuses, type CaptureStatusInput, type Sense, type SenseStatus } from './capture-status.js'

const base: CaptureStatusInput = { platform: 'darwin', sysAudio: 'unknown', screenEnabled: false }
const run = (over: Partial<CaptureStatusInput> = {}): SenseStatus[] => captureStatuses({ ...base, ...over })
const bySense = (statuses: SenseStatus[], sense: Sense): SenseStatus => statuses.find((s) => s.sense === sense)!

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

test('off macOS the media senses read as unsupported (no false TCC claims)', () => {
  const linux = run({ platform: 'linux' }) // micAccess/screenAccess omitted (undefined) as the shell does off-darwin
  assert.equal(bySense(linux, 'mic').level, 'unsupported')
  assert.equal(bySense(linux, 'screen').level, 'unsupported')
  assert.equal(bySense(linux, 'mic').fixCommand, undefined)
})
