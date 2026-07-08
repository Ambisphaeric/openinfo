import type { QueueFailure } from '@openinfo/contracts'
import { describeInvokeFailure, type ClassifiedFailure } from './invoke-error.js'
import { loadedModelSuggestion } from './discover.js'

/**
 * The diagnosis bridge (INVOKE-RESILIENCE): turn a raw invoke throw into the surface-ready QueueFailure,
 * enriching a model-load failure with the loaded-model suggestion (user agency — it TELLS, never switches).
 * Used by the queue drain (records the last failure) and the generate probe (reports it). Kept separate
 * from invoke-error.ts because THIS layer is allowed to do I/O (a read-only /v1/models probe); the
 * classification itself is pure.
 */

/** Append the loaded-model suggestion to a model-load failure's hint (a read-only server probe). */
export const enrichFailureHint = async (failure: ClassifiedFailure, timeoutMs?: number): Promise<string> => {
  if (failure.class !== 'model-load') return failure.hint
  const suggestion = await loadedModelSuggestion(failure.url, failure.model, timeoutMs)
  return suggestion ? `${failure.hint}. ${suggestion}` : failure.hint
}

/**
 * From an invoke throw, produce the QueueFailure (classified + enriched hint + stamped time), or
 * undefined when the error is not an invoke failure (a non-invoke drain error is logged, not faked into a
 * class). `probe` is injectable so tests can run without a live server.
 */
export const toQueueFailure = async (
  error: unknown,
  at: string,
  enrich: (failure: ClassifiedFailure) => Promise<string> = enrichFailureHint,
): Promise<QueueFailure | undefined> => {
  const c = describeInvokeFailure(error)
  if (!c) return undefined
  const hint = await enrich(c)
  return {
    class: c.class,
    endpoint: c.endpoint,
    ...(c.model !== undefined ? { model: c.model } : {}),
    ...(c.keyRef !== undefined ? { keyRef: c.keyRef } : {}),
    ...(c.serverMessage !== undefined ? { serverMessage: c.serverMessage } : {}),
    hint,
    at,
  }
}
