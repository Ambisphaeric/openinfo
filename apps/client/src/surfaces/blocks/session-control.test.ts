import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { NowContext } from '../block-renderer/index.js'
import { renderToHtml } from '../block-renderer/vnode.js'
import { renderSessionControl, renderSessionControlBlock, NO_BRIDGE_REASON } from './session-control.js'

/**
 * The #136 on-surface session control, driven through the PURE renderer — the full honest-state matrix in
 * one place. The mount-layer dispatch (a click on the live button reaches the injected start/stop handler,
 * a disabled one never does) is driven in action-verbs.test.ts; the served note-taker + interaction-lint
 * frames prove it end-to-end through the real renderNotetaker. Here we pin each STATE's honest rendering.
 */

const html = (input: Parameters<typeof renderSessionControl>[0]): string => renderToHtml(renderSessionControl(input))

test('ready + stopped → a LIVE Record button carrying the wired session-start verb', () => {
  const out = html({ live: false, readiness: { ready: true } })
  assert.match(out, /class="session-record"[^>]*data-nt="record"[^>]*data-verb="session-start"/)
  assert.match(out, />Record</)
  assert.doesNotMatch(out, /disabled/) // genuinely live — not the placeholder
  assert.doesNotMatch(out, /session-record-note/) // no capture note while stopped
})

test('ready + live → the SAME control STOPS the session (session-stop) + an honest capture note', () => {
  const out = html({ live: true, readiness: { ready: true, capture: { tone: 'rec', note: 'Recording · mic + system' } } })
  assert.match(out, /class="session-record recording"[^>]*data-nt="record"[^>]*data-verb="session-stop"/)
  assert.match(out, />Stop</)
  assert.match(out, /class="session-record-note">Recording · mic \+ system/)
})

test('ready + live + mic blocked → still stoppable (the session path works), capture note warns honestly', () => {
  // Parity with the tray: a mic block does NOT disable start/stop — the session + text path still runs, so
  // the control stays live and the block is surfaced as an honest WARN note, never a fake-dead button.
  const out = html({ live: true, readiness: { ready: true, capture: { tone: 'warn', note: 'Mic blocked — audio off, notes still capture' } } })
  assert.match(out, /data-verb="session-stop"/) // still actionable
  assert.match(out, /class="session-record-note warn">Mic blocked — audio off/)
})

test('NOT ready → a DISABLED button with the true reason inline (never a fake-live button)', () => {
  for (const reason of ['Engine unreachable — reconnecting', 'Engine refused — version mismatch', 'Connecting to the engine…']) {
    const out = html({ live: false, readiness: { ready: false, reason } })
    assert.match(out, /class="session-record pending"[^>]*data-nt="record"[^>]*disabled/)
    assert.match(out, new RegExp(`class="session-record-note">${reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    assert.doesNotMatch(out, /data-verb=/) // a disabled control carries no verb — it can never dispatch
  }
})

test('no readiness at all (a plain browser / served frame) → disabled with the desktop-app reason', () => {
  const out = html({ live: true }) // even "live" cannot make an unbridged control actionable
  assert.match(out, /class="session-record pending"[^>]*disabled/)
  assert.match(out, new RegExp(`class="session-record-note">${NO_BRIDGE_REASON}`))
})

test('the block adapter reads live from now.live and readiness from the threaded session context', () => {
  const now = (live: boolean): NowContext => ({ live, workspace: 'acme' })
  // block wiring: now.live=false + ready → start; now.live=true + ready → stop; readiness absent → disabled
  assert.match(renderToHtml(renderSessionControlBlock({ block: { block: 'session-control' }, now: now(false), session: { ready: true } })), /data-verb="session-start"/)
  assert.match(renderToHtml(renderSessionControlBlock({ block: { block: 'session-control' }, now: now(true), session: { ready: true } })), /data-verb="session-stop"/)
  assert.match(renderToHtml(renderSessionControlBlock({ block: { block: 'session-control' }, now: now(true) })), /class="session-record pending"[^>]*disabled/)
})
