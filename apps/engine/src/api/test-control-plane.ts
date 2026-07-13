/**
 * Authenticated test harness for the engine API. This is intentionally not an auth bypass: every protected
 * test request still carries a fixed bearer and every WS carries the matching subprotocol credential. The
 * only relaxation is port discovery — route tests bind port 0, so Host accepts any loopback port.
 */
import type { EngineOptions } from './http.js'
import { createEngineApp } from './http.js'
import {
  controlTokenDigest,
  validateControlToken,
  isLoopbackControlHost,
  type ControlPlaneAccess,
  type EventSocketPolicy,
  type PublicControlPlanePolicy,
} from './control-plane.js'

export const TEST_CONTROL_TOKEN = 'openinfo_test_control_token_0123456789ab'
const TEST_DIGEST = controlTokenDigest(TEST_CONTROL_TOKEN)

const hostIsLoopback = (raw: string | undefined): boolean => {
  if (raw === undefined || raw.trim() === '' || /[\s/@]/.test(raw)) return false
  try {
    return isLoopbackControlHost(new URL(`http://${raw}`).hostname)
  } catch {
    return false
  }
}

const originIsAllowed = (raw: string | undefined): boolean => {
  if (raw === undefined || raw === 'null' || raw === 'file://') return true
  try {
    const url = new URL(raw)
    return url.origin === raw.replace(/\/$/, '') && url.protocol === 'http:' && isLoopbackControlHost(url.hostname)
  } catch {
    return false
  }
}

export const secureTestControlPlane = (): ControlPlaneAccess => {
  const authenticate = (token: string | undefined): boolean => validateControlToken(TEST_DIGEST, token)
  const socket: EventSocketPolicy = {
    validateHost: hostIsLoopback,
    validateOrigin: originIsAllowed,
    authenticate: (token) => authenticate(token),
  }
  return {
    mode: 'local',
    publicOrigin: undefined,
    authenticate,
    validateHost: hostIsLoopback,
    validateOrigin: originIsAllowed,
    eventSocketPolicy: () => socket,
    publicPolicy: (): PublicControlPlanePolicy => ({
      authRequired: true,
      instanceId: 'secure-test-control-plane',
      mode: 'local',
      transport: 'loopback-http',
    }),
  }
}

export const createSecureTestEngineApp = (options: Omit<EngineOptions, 'controlPlane'> = {}) =>
  createEngineApp({ ...options, controlPlane: secureTestControlPlane() })

/** Adds the real product headers while preserving deliberately hostile headers supplied by a test. */
export const secureTestFetch: typeof globalThis.fetch = async (input, init = {}) => {
  const headers = new Headers(init.headers)
  if (!headers.has('authorization')) headers.set('authorization', `Bearer ${TEST_CONTROL_TOKEN}`)
  const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  if ((method === 'POST' || method === 'PUT' || method === 'DELETE') && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return globalThis.fetch(input, { ...init, headers })
}

export const testWsProtocols = (): string[] => ['openinfo.v1', `openinfo.auth.${TEST_CONTROL_TOKEN}`]
