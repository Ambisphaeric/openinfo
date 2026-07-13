import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BrowserAuthSessions } from './browser-auth.js'

test('browser tickets expire, are one-use, and tunnel cookies are Secure without carrying the control token', () => {
  let nowMs = Date.parse('2026-07-12T15:00:00.000Z')
  const tokens = ['ticket_token_0123456789012345678901234567', 'session_token_01234567890123456789012345']
  const auth = new BrowserAuthSessions({
    now: () => new Date(nowMs),
    randomToken: () => tokens.shift()!,
  })
  const issued = auth.issue('https://control.example.test')
  assert.equal(issued.url, 'https://control.example.test/auth/browser?ticket=ticket_token_0123456789012345678901234567')
  const consumed = auth.consume(new URL(issued.url).searchParams.get('ticket'), true)
  assert.ok(consumed)
  assert.match(consumed.cookie, /HttpOnly; SameSite=Strict/)
  assert.match(consumed.cookie, /; Secure$/)
  assert.equal(auth.authenticateCookie(consumed.cookie.split(';', 1)[0]), true)
  assert.equal(auth.consume(new URL(issued.url).searchParams.get('ticket'), true), undefined)

  nowMs += 8 * 60 * 60 * 1000 + 1
  assert.equal(auth.authenticateCookie(consumed.cookie.split(';', 1)[0]), false)
})

test('an expired ticket is consumed as invalid and cannot be replayed', () => {
  let nowMs = Date.parse('2026-07-12T15:00:00.000Z')
  const auth = new BrowserAuthSessions({
    now: () => new Date(nowMs),
    randomToken: () => 'expired_ticket_0123456789012345678901234',
  })
  const issued = auth.issue('http://127.0.0.1:8787')
  const ticket = new URL(issued.url).searchParams.get('ticket')
  nowMs += 30_001
  assert.equal(auth.consume(ticket, false), undefined)
  assert.equal(auth.consume(ticket, false), undefined)
})
