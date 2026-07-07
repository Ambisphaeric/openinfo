/**
 * Defensive JSON parsing for structured llm output, shared by the moment (distill/moments.ts) and
 * entity (distill/entities.ts) extractors. Small local models emit fences, prose preambles, trailing
 * commas, and half-broken arrays; this recovers as much object-shaped content as possible without
 * ever throwing. Policy documented in PHASE2-NOTES (Moments v0, malformed-JSON policy).
 */

/** Strip markdown code fences small models love to wrap JSON in. */
export const stripFences = (raw: string): string => raw.replace(/```(?:json)?/gi, '').trim()

export const tryParse = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/**
 * Scan for top-level balanced `{…}` substrings, honoring string literals and escapes. Salvages
 * per-object: an array with one broken element still yields its intact siblings, and JSONL / comma-
 * free object streams parse. Never throws.
 */
export const scanBalancedObjects = (text: string): string[] => {
  const objects: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      if (depth === 0) start = i
      depth += 1
    } else if (ch === '}') {
      if (depth > 0) {
        depth -= 1
        if (depth === 0 && start >= 0) {
          objects.push(text.slice(start, i + 1))
          start = -1
        }
      }
    }
  }
  return objects
}

/**
 * Defensively parse an llm response into candidate objects. Returns `parsedAnything: false` only
 * when nothing object-shaped could be recovered at all (the signal for a bounded re-sample). A
 * clean empty array (`[]`) counts as parsed — zero candidates is a normal outcome, not a failure.
 * `wrapperKey` unwraps a `{ <wrapperKey>: [...] }` object (e.g. `{ "moments": [...] }`) small models
 * sometimes emit instead of a bare array.
 */
export const parseJsonCandidates = (raw: string, wrapperKey?: string): { candidates: unknown[]; parsedAnything: boolean } => {
  const text = stripFences(raw)
  const whole = tryParse(text)
  if (Array.isArray(whole)) return { candidates: whole, parsedAnything: true }
  if (whole !== null && typeof whole === 'object') {
    if (wrapperKey !== undefined) {
      const wrapped = (whole as Record<string, unknown>)[wrapperKey]
      if (Array.isArray(wrapped)) return { candidates: wrapped, parsedAnything: true }
    }
    return { candidates: [whole], parsedAnything: true }
  }
  const candidates = scanBalancedObjects(text)
    .map(tryParse)
    .filter((v): v is Record<string, unknown> => v !== null && typeof v === 'object')
  return { candidates, parsedAnything: candidates.length > 0 }
}
