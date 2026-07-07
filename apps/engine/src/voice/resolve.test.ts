import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Register, VoiceBinding } from '@openinfo/contracts'
import { resolveVoice, NEUTRAL_DIALS } from './resolve.js'
import { compileVoiceVars, interpolateTemplate, compileVoiceRules } from './interpolate.js'

const registers: Register[] = [
  { id: 'reg-global', name: 'g', dials: { tone: 1, warmth: 1, wit: 1, charm: 1, specificity: 1, brevity: 1 } },
  { id: 'reg-mode', name: 'm', dials: { tone: 2, warmth: 2, wit: 2, charm: 2, specificity: 2, brevity: 2 } },
  { id: 'reg-ws', name: 'w', dials: { tone: 3, warmth: 3, wit: 3, charm: 3, specificity: 3, brevity: 3 } },
  { id: 'reg-ses', name: 's', dials: { tone: 4, warmth: 4, wit: 4, charm: 4, specificity: 4, brevity: 4 } },
]

const ctx = { sessionId: 'ses-1', workspaceId: 'ws-1', modeId: 'mode-1' }

const bind = (scope: VoiceBinding['scope'], registerId: string, targetId?: string): VoiceBinding =>
  targetId === undefined ? { scope, registerId } : { scope, registerId, targetId }

test('unbound context resolves to the neutral fallback', () => {
  const r = resolveVoice(registers, [], ctx)
  assert.equal(r.fallback, true)
  assert.equal(r.scope, 'global')
  assert.deepEqual(r.dials, NEUTRAL_DIALS)
})

test('global binding applies when nothing more specific matches', () => {
  const r = resolveVoice(registers, [bind('global', 'reg-global')], ctx)
  assert.equal(r.scope, 'global')
  assert.equal(r.registerId, 'reg-global')
  assert.equal(r.dials.tone, 1)
})

test('resolution order: session > workspace > mode > global', () => {
  const all = [
    bind('global', 'reg-global'),
    bind('mode', 'reg-mode', 'mode-1'),
    bind('workspace', 'reg-ws', 'ws-1'),
    bind('session', 'reg-ses', 'ses-1'),
  ]
  assert.equal(resolveVoice(registers, all, ctx).scope, 'session')
  assert.equal(resolveVoice(registers, all.slice(0, 3), ctx).scope, 'workspace')
  assert.equal(resolveVoice(registers, all.slice(0, 2), ctx).scope, 'mode')
  assert.equal(resolveVoice(registers, all.slice(0, 1), ctx).scope, 'global')
})

test('a scope binding only matches its own targetId', () => {
  const r = resolveVoice(registers, [bind('session', 'reg-ses', 'other-session')], ctx)
  assert.equal(r.fallback, true) // wrong target → falls through to neutral
})

test('dialOverrides layer on top of the register vector', () => {
  const binding: VoiceBinding = { scope: 'mode', registerId: 'reg-mode', targetId: 'mode-1', dialOverrides: { charm: 9 } }
  const r = resolveVoice(registers, [binding], ctx)
  assert.equal(r.dials.charm, 9)
  assert.equal(r.dials.tone, 2) // untouched dial stays from the register
})

test('a dangling binding (missing register) falls through to the next scope', () => {
  const all = [bind('session', 'reg-missing', 'ses-1'), bind('mode', 'reg-mode', 'mode-1')]
  const r = resolveVoice(registers, all, ctx)
  assert.equal(r.scope, 'mode')
  assert.equal(r.registerId, 'reg-mode')
})

test('compiled voice vars expose raw numbers and a rules snippet', () => {
  const vars = compileVoiceVars({ tone: 3, warmth: 4, wit: 2, charm: 2, specificity: 9, brevity: 8 })
  assert.equal(vars['charm'], '2')
  assert.equal(vars['specificity'], '9')
  assert.match(vars['voice.rules'] ?? '', /humor/i)
  assert.match(vars['voice.rules'] ?? '', /page/i)
})

test('interpolate replaces known placeholders and blanks unknown ones', () => {
  const out = interpolateTemplate('charm {{charm}}/10 {{voice.rules}} [{{nope}}]', {
    charm: '2',
    'voice.rules': compileVoiceRules({ tone: 3, warmth: 4, wit: 2, charm: 2, specificity: 9, brevity: 8 }),
  })
  assert.match(out, /^charm 2\/10 /)
  assert.match(out, /\[\]$/)
})
