import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionAnnotation } from '@openinfo/contracts'
import { SESSION_ANNOTATION_SCHEMA_VERSION } from '@openinfo/contracts'
import { deriveEpisodeTitle } from './episode-title.js'

const annotation = (over: Partial<SessionAnnotation> = {}): SessionAnnotation => ({
  id: 'oa:default:s1',
  workspaceId: 'default',
  sessionId: 's1',
  nature: 'meeting',
  direction: 'learn',
  topics: ['Q3 GTM launch sequencing'],
  provenance: { templateId: 'tpl-judge-orientation', endpoint: 'llm.judge', classifiedAt: '2026-07-10T12:00:00.000Z' },
  updatedAt: '2026-07-10T12:00:00.000Z',
  schemaVersion: SESSION_ANNOTATION_SCHEMA_VERSION,
  ...over,
})

test('#211 derive: a meeting is named "Meeting on <topic>"', () => {
  assert.equal(deriveEpisodeTitle(annotation()), 'Meeting on Q3 GTM launch sequencing')
})

test('#211 derive: a call is named "Call about <topic>"; solo work "Working on <topic>"', () => {
  assert.equal(deriveEpisodeTitle(annotation({ nature: 'call' })), 'Call about Q3 GTM launch sequencing')
  assert.equal(deriveEpisodeTitle(annotation({ nature: 'solo-work' })), 'Working on Q3 GTM launch sequencing')
})

test('#211 derive: two topics join the human way ("A and B"); more than two are dropped (glanceable)', () => {
  assert.equal(
    deriveEpisodeTitle(annotation({ nature: 'call', topics: ['renewal terms', 'security review', 'pricing'] })),
    'Call about renewal terms and security review',
  )
})

test('#211 derive: an unclear/unknown nature names the topics plainly, sentence-cased, no invented framing', () => {
  assert.equal(deriveEpisodeTitle(annotation({ nature: 'unclear', topics: ['weekly sync notes'] })), 'Weekly sync notes')
})

test('#211 derive: NO topics ⇒ undefined — nothing meaningful to name (honest, no hollow "Meeting")', () => {
  assert.equal(deriveEpisodeTitle(annotation({ topics: [] })), undefined)
  assert.equal(deriveEpisodeTitle(annotation({ nature: 'unclear', direction: 'unclear', topics: [] })), undefined)
})

test('#211 derive: a runaway topic is clamped to a glanceable length on a word boundary', () => {
  const long = 'an extraordinarily long and rambling subject phrase that just keeps going well past any glanceable length'
  const title = deriveEpisodeTitle(annotation({ nature: 'solo-work', topics: [long] }))!
  assert.ok(title.length <= 80, `title should be clamped, got ${title.length}`)
  assert.doesNotMatch(title, /\s$/, 'no trailing space')
  assert.ok(!title.includes('  '), 'no double spaces')
})
