import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatContextSource, Entity, PinChunk, RelevantEntity } from '@openinfo/contracts'
import { assembleChatContext, describeAssembly, estimateTokens, type GatheredContext, type SourceReport } from './context-assembly.js'
import { WorkspaceRegistry } from '../store/index.js'
import { BundleDocuments, DEFAULT_BUNDLE_ID } from '../bundles/index.js'

const entity = (name: string, kind: Entity['kind'], momentText?: string): RelevantEntity => ({
  entity: { id: `ent-${name}`, workspaceId: 'default', kind, name, aliases: [], momentRefs: [], outboundCount: 0, mentions: 1, firstSeen: '2026-07-10T14:00:00Z', lastSeen: '2026-07-10T14:40:00Z' },
  score: 1,
  moments: momentText ? [{ id: 'm', sessionId: 's', workspaceId: 'default', at: '2026-07-10T14:00:00Z', kind: 'context', text: momentText, refs: [], source: 'mic', confidence: 0.8 }] : [],
})
const chunk = (ordinal: number, text: string, page?: number): PinChunk => ({
  id: `c-${ordinal}`, pinId: 'pin-1', workspaceId: 'default', ordinal, ...(page !== undefined ? { page } : {}), text, createdAt: '2026-07-10T14:00:00Z',
})

const bare: GatheredContext = {
  bundlePrompt: 'You are the assistant.',
  activePreset: { available: false },
  transcript: '',
  insights: [],
  entities: [],
  attachedDocs: { chunks: [] },
  recentTurns: [],
  screen: { attempted: false },
}
const report = (reports: readonly SourceReport[], kind: string): SourceReport => reports.find((r) => r.kind === kind)!

test('assembles declared sources IN ORDER and reports each one', () => {
  const sources: ChatContextSource[] = [
    { kind: 'bundle-prompt' },
    { kind: 'relevant-entities', limit: 8 },
    { kind: 'attached-docs', limit: 4 },
  ]
  const out = assembleChatContext(sources, {
    ...bare,
    entities: [entity('Acme', 'org', 'renewal in Q3')],
    attachedDocs: { pinId: 'pin-1', pinTitle: 'contract.txt', chunks: [chunk(0, 'the term is 12 months', 4)] },
  })
  // Declared order preserved: prompt, then entities, then excerpts.
  assert.ok(out.contextText.indexOf('You are the assistant.') < out.contextText.indexOf('Known in this session'))
  assert.ok(out.contextText.indexOf('Known in this session') < out.contextText.indexOf('Excerpts from contract.txt'))
  assert.match(out.contextText, /- Acme \(org\) — renewal in Q3/)
  assert.match(out.contextText, /\[p\.4\] the term is 12 months/)
  assert.equal(out.citations.length, 1)
  assert.deepEqual(out.citations[0], { pinId: 'pin-1', pinTitle: 'contract.txt', ordinal: 0, page: 4, excerpt: 'the term is 12 months' })
  assert.equal(out.reports.length, 3)
  assert.equal(report(out.reports, 'bundle-prompt').status, 'included')
  assert.equal(report(out.reports, 'relevant-entities').status, 'included')
  assert.equal(out.truncated, false)
})

test('a wired-but-empty source reports empty; an unfilled seam reports unavailable — never silent', () => {
  const out = assembleChatContext(
    [{ kind: 'active-preset' }, { kind: 'transcript-window' }, { kind: 'insights' }, { kind: 'recent-turns' }],
    bare,
  )
  assert.equal(report(out.reports, 'active-preset').status, 'unavailable') // seam absent (available: false)
  assert.equal(report(out.reports, 'transcript-window').status, 'empty')
  assert.equal(report(out.reports, 'insights').status, 'empty')
  assert.equal(report(out.reports, 'recent-turns').status, 'empty')
  assert.equal(out.contextText, '') // nothing entered
})

test('active-preset: wired seam with no selection is empty; with a ref it is injected', () => {
  const emptySeam = assembleChatContext([{ kind: 'active-preset' }], { ...bare, activePreset: { available: true, ref: undefined } })
  assert.equal(report(emptySeam.reports, 'active-preset').status, 'empty')

  const withPreset = assembleChatContext([{ kind: 'active-preset' }], { ...bare, activePreset: { available: true, ref: { label: 'Terse', text: 'Be very terse.' } } })
  assert.equal(report(withPreset.reports, 'active-preset').status, 'included')
  assert.match(withPreset.contextText, /Voice\/register — Terse:/)
  assert.match(withPreset.contextText, /Be very terse\./)
})

test('limit caps item count and reports capped with the honest of-count', () => {
  const many = Array.from({ length: 12 }, (_, i) => entity(`E${i}`, 'org'))
  const out = assembleChatContext([{ kind: 'relevant-entities', limit: 5 }], { ...bare, entities: many })
  const r = report(out.reports, 'relevant-entities')
  assert.equal(r.status, 'capped')
  assert.equal(r.items, 5)
  assert.equal(r.available, 12)
  assert.equal(out.truncated, true)
})

test('transcript windowChars keeps the MOST RECENT characters (rolling window)', () => {
  const transcript = `${'A'.repeat(100)}TAIL`
  const out = assembleChatContext([{ kind: 'transcript-window', windowChars: 4 }], { ...bare, transcript })
  assert.match(out.contextText, /Live transcript \(recent\):\nTAIL/)
  assert.equal(report(out.reports, 'transcript-window').status, 'capped')
})

test('attached-docs honors tokenBudget (chars/4) and keeps at least one excerpt, disclosing the cap', () => {
  const big = Array.from({ length: 10 }, (_, i) => chunk(i, 'x'.repeat(200), i + 1))
  // tokenBudget 60 ⇒ ~240 char budget.
  const out = assembleChatContext([{ kind: 'attached-docs', tokenBudget: 60 }], { ...bare, attachedDocs: { pinId: 'pin-1', pinTitle: 'big.txt', chunks: big } })
  const r = report(out.reports, 'attached-docs')
  assert.equal(r.status, 'capped')
  assert.ok(r.items >= 1 && r.items < r.available)
  assert.equal(r.available, 10)
})

test('recent-turns rides as history messages (not the system block) and keeps the most recent', () => {
  const turns = Array.from({ length: 6 }, (_, i) => ({ role: 'user' as const, content: `turn ${i}` }))
  const out = assembleChatContext([{ kind: 'recent-turns', limit: 2 }], { ...bare, recentTurns: turns })
  assert.deepEqual(out.historyTurns, [{ role: 'user', content: 'turn 4' }, { role: 'user', content: 'turn 5' }])
  assert.equal(out.contextText, '') // turns are messages, not system context
  assert.equal(report(out.reports, 'recent-turns').status, 'capped')
})

test('describeAssembly names what entered and, separately, what was omitted and why', () => {
  const note = describeAssembly([
    { kind: 'bundle-prompt', status: 'included', items: 1, available: 1, chars: 20 },
    { kind: 'attached-docs', status: 'capped', items: 3, available: 12, chars: 900 },
    { kind: 'insights', status: 'empty', items: 0, available: 0, chars: 0 },
    { kind: 'active-preset', status: 'unavailable', items: 0, available: 0, chars: 0 },
  ])
  assert.match(note, /Context: bundle-prompt\(1\), attached-docs\(3 of 12, capped\)\./)
  assert.match(note, /Omitted: insights \(empty\), active-preset \(unavailable\)\./)
})

test('estimateTokens is chars/4', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('abcde'), 2)
})

// The heart of pill P1: a declaration change through the store (PUT-equivalent BundleDocuments.save)
// changes assembly with NO code change. Edit the bundle doc, re-read it, assemble — observe the difference.
test('a stored bundle edit changes assembly with no code change (declaration is data)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-ctx-'))
  try {
    const store = new WorkspaceRegistry(dir)
    const bundles = new BundleDocuments(store)
    bundles.ensureDefaults()

    const gathered: GatheredContext = {
      ...bare,
      entities: [entity('Acme', 'org')],
      transcript: 'live words here',
    }

    // As shipped, the Standard App declares transcript-window AND relevant-entities → both assemble.
    const before = bundles.get(DEFAULT_BUNDLE_ID)!
    const asShipped = assembleChatContext(before.chat!.sources, gathered)
    assert.match(asShipped.contextText, /Live transcript/)
    assert.match(asShipped.contextText, /Known in this session/)

    // Edit the DOCUMENT: keep only the bundle prompt. Save it (the PUT write half, version-stamped).
    bundles.save({ ...before, chat: { sources: [{ kind: 'bundle-prompt' }] } })

    // Re-read fresh and assemble — the SAME code now produces a DIFFERENT context, driven purely by data.
    const after = bundles.get(DEFAULT_BUNDLE_ID)!
    assert.equal(after.version, before.version + 1)
    const edited = assembleChatContext(after.chat!.sources, gathered)
    assert.doesNotMatch(edited.contextText, /Live transcript/)
    assert.doesNotMatch(edited.contextText, /Known in this session/)
    assert.match(edited.contextText, /You are the assistant\./)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Ask face `screen` source: the four honest states (no frame / unreadable / blank / text), capped', () => {
  const sources: ChatContextSource[] = [{ kind: 'screen', windowChars: 40 }]
  // No frame this turn ⇒ empty (wired, nothing to contribute).
  assert.equal(report(assembleChatContext(sources, bare).reports, 'screen').status, 'empty')
  // A frame shipped but could not be read (no ocr/vlm endpoint, invoke failure) ⇒ unavailable, disclosed.
  const unreadable = assembleChatContext(sources, { ...bare, screen: { attempted: true, failure: 'no ocr endpoint answered' } })
  assert.equal(report(unreadable.reports, 'screen').status, 'unavailable')
  assert.ok(!unreadable.contextText.includes('screen'), 'nothing enters the context for an unreadable frame')
  // A blank frame ('' recognized) is a NORMAL empty result, not an error.
  assert.equal(report(assembleChatContext(sources, { ...bare, screen: { attempted: true, text: '   ' } }).reports, 'screen').status, 'empty')
  // Screen text in hand enters as its own block, clipped by the DECLARED budget (capped, disclosed).
  const long = 'INVOICE #42 — total $1,300 due Friday, approve in the billing tab'
  const out = assembleChatContext(sources, { ...bare, screen: { attempted: true, text: long } })
  const rep = report(out.reports, 'screen')
  assert.equal(rep.status, 'capped')
  assert.match(out.contextText, /On the user's screen right now \(read at send\):\nINVOICE #42/)
  assert.ok(out.truncated, 'a capped screen source flips the honest truncated flag')
  // Within budget ⇒ included, whole text.
  const short = assembleChatContext([{ kind: 'screen' }], { ...bare, screen: { attempted: true, text: 'a tiny toolbar' } })
  assert.equal(report(short.reports, 'screen').status, 'included')
  assert.match(short.contextText, /a tiny toolbar/)
  // The disclosure note names the omission states in human terms.
  assert.match(describeAssembly(unreadable.reports), /screen \(unavailable\)/)
})
