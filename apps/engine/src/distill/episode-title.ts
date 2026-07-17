import type { SessionAnnotation } from '@openinfo/contracts'

/** A derived episode title never runs long — a glanceable name, not a sentence. Bounded, word-safe. */
const MAX_TITLE_CHARS = 80

/** Uppercase the first visible character; leave the rest (acronyms/proper nouns are the model's to keep). */
const capitalizeFirst = (s: string): string => (s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1))

/** Join up to two topic phrases the human way — "A" or "A and B". More than two would stop being glanceable. */
const humanTopics = (topics: readonly string[]): string => {
  const top = topics.slice(0, 2)
  return top.length === 2 ? `${top[0]} and ${top[1]}` : (top[0] ?? '')
}

/** Trim to the length cap on a word boundary so a derived title never ends mid-word or mid-space. */
const clamp = (s: string): string => {
  const collapsed = s.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= MAX_TITLE_CHARS) return collapsed
  const cut = collapsed.slice(0, MAX_TITLE_CHARS)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim()
}

/**
 * Derive a human-meaningful episode title from an orientation classification (#211). PURE + deterministic:
 * the model output (the SessionAnnotation) is the PROPOSAL; the title is a plain transform of it, so no
 * second model call is spent and nothing is invented. The title leads with the topics (the meaningful
 * content), lightly framed by the session's nature, in the calm human voice the HUD speaks (no ids, no
 * jargon, sentence-cased).
 *
 * Honest degradation: with NO topics the source is too thin to name anything specific, so this returns
 * `undefined` rather than minting a hollow "Meeting" — the caller falls back to an honest start-time label.
 */
export const deriveEpisodeTitle = (annotation: SessionAnnotation): string | undefined => {
  const topics = annotation.topics.map((t) => t.trim()).filter((t) => t.length > 0)
  if (topics.length === 0) return undefined
  const phrase = humanTopics(topics)
  switch (annotation.nature) {
    case 'meeting':
      return clamp(`Meeting on ${phrase}`)
    case 'call':
      return clamp(`Call about ${phrase}`)
    case 'solo-work':
      return clamp(`Working on ${phrase}`)
    default:
      // "unclear" or a tuned/unknown nature vocab: name the topics plainly, no invented framing.
      return clamp(capitalizeFirst(phrase))
  }
}
