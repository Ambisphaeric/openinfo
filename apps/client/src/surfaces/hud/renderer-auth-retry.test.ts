import assert from 'node:assert/strict'
import { test } from 'node:test'
import { retryOnceOnUnauthorized } from './dev-entry.js'

const response = (status: number): Response => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => ({}),
} as Response)

test('renderer fetch retries exactly once on 401 so main can inject the refreshed bearer', async () => {
  const statuses = [401, 200]
  let calls = 0
  const wrapped = retryOnceOnUnauthorized(async () => {
    const status = statuses[calls] ?? 500
    calls += 1
    return response(status)
  })
  assert.equal((await wrapped('http://engine/query')).status, 200)
  assert.equal(calls, 2)
})

test('renderer fetch does not retry non-401 or retry a second 401', async () => {
  let forbiddenCalls = 0
  const forbidden = retryOnceOnUnauthorized(async () => {
    forbiddenCalls += 1
    return response(403)
  })
  assert.equal((await forbidden('http://engine/query')).status, 403)
  assert.equal(forbiddenCalls, 1)

  let unauthorizedCalls = 0
  const unauthorized = retryOnceOnUnauthorized(async () => {
    unauthorizedCalls += 1
    return response(401)
  })
  assert.equal((await unauthorized('http://engine/query')).status, 401)
  assert.equal(unauthorizedCalls, 2)
})
