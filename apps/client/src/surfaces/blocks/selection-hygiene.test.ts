import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Block, Distillate, Entity, RelevantEntity, Summary, TodoItem } from '@openinfo/contracts'
import type { NowContext } from '../block-renderer/index.js'
import type { VNode } from '../block-renderer/vnode.js'
import { hudStyles } from '../hud/styles.js'
import { panelStyles } from '../hud/panel-styles.js'
import { defaultBlockRegistry } from './index.js'

/**
 * SELECTION-HYGIENE regression (#242) — the headline QA defect: the HUD is used to select/copy VALUES out
 * of rows, and a native double-click / drag / select-all must capture the bare value and NOTHING else (no
 * why/context line, no mark glyph, no kind tag, no affordance label). The bug the owner saw was selecting a
 * summary line yielding "<value>.<why-line>".
 *
 * The client has no bundler and the renderer is a PURE vnode tree, so this test proves the mechanism WITHOUT
 * a DOM: it derives the set of non-selectable classes FROM THE ACTUAL STYLESHEET (never a hardcoded list),
 * then walks a rendered row collecting the text a browser selection would keep — every text node with no
 * `user-select:none` ancestor — and asserts it equals the bare value. Deriving the set from the live
 * stylesheet is the by-construction guard: delete a rule in styles.ts and the matching decoration text leaks
 * into `selectableText`, failing the equality below; the explicit `has(...)` assertions and the negative
 * probe make that dependency load-bearing rather than vacuously green.
 */

const now: NowContext = { live: true }

/**
 * Parse a CSS string into the set of classes made non-selectable. For each rule whose body declares
 * `user-select:none`, the SUPPRESSED element is the last simple selector in each comma-separated selector
 * (e.g. `.rel .body .ttl .ext` suppresses `.ext`; `.rel .go` suppresses `.go` and its children by
 * inheritance), so we take the trailing class token. No hardcoded class list — the stylesheet is the source.
 */
const parseSuppressedClasses = (rawCss: string): Set<string> => {
  const out = new Set<string>()
  // Strip CSS comments first — they are not selectors, and ours name value classes (.ttl, .in-msg) that
  // must NOT be treated as suppressed.
  const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const rule of css.split('}')) {
    const brace = rule.indexOf('{')
    if (brace === -1) continue
    const selectorList = rule.slice(0, brace)
    const body = rule.slice(brace + 1)
    if (!/user-select\s*:\s*none/.test(body)) continue
    for (const selector of selectorList.split(',')) {
      const classes = selector.trim().match(/\.[A-Za-z0-9_-]+/g)
      if (classes && classes.length > 0) out.add(classes[classes.length - 1]!.slice(1))
    }
  }
  return out
}

const hasSuppressedClass = (attrs: Record<string, unknown>, suppressed: ReadonlySet<string>): boolean => {
  const cls = attrs['class']
  return typeof cls === 'string' && cls.split(/\s+/).some((c) => suppressed.has(c))
}

/** The text a native selection across `node` would keep: every text node NOT under a user-select:none ancestor. */
const selectableText = (node: VNode, suppressed: ReadonlySet<string>, under = false): string => {
  if (typeof node === 'string') return under ? '' : node
  const nowUnder = under || hasSuppressedClass(node.attrs, suppressed)
  return node.children.map((child) => selectableText(child, suppressed, nowUnder)).join('')
}

const render = (block: Block, items: unknown[]): VNode => {
  const node = defaultBlockRegistry[block.block]!({ block, now, result: { source: block.query!.source, items, truncated: false } })
  assert.ok(node && !Array.isArray(node), 'block renders a single root node')
  return node
}

const copyAction = [{ id: 'a-copy', label: 'Copy', verb: 'copy' as const, params: {} }]

const suppressed = parseSuppressedClasses(`${hudStyles}\n${panelStyles}`)

// A link surfaces as an `artifact` entity whose `name` is the extracted surface form — a FULL URL here, to
// double as the "fully realized value" proof: the whole URL selects, and none of the row decoration does.
const linkEntity: Entity = {
  id: 'e-link', workspaceId: 'ws', kind: 'artifact', name: 'https://docs.example.com/soc2?section=controls#c-4',
  aliases: [], momentRefs: [], outboundCount: 0, mentions: 3,
  firstSeen: '2026-07-16T19:57:00Z', lastSeen: '2026-07-16T19:57:00Z',
  provenance: [{ slot: 'llm', endpoint: 'dev-mac-omlx', windowEnd: '2026-07-16T19:57:00Z' }],
  sightings: [{ via: 'heard', at: '2026-07-16T19:57:00Z' }],
}
const relBlock: Block = { block: 'relevant-now', show: 'always', query: { source: 'relevant-now', params: {} }, actions: copyAction }
const rel: RelevantEntity = { entity: linkEntity, score: 1, moments: [] }
const relNode = render(relBlock, [rel])

const todoBlock: Block = { block: 'todos', show: 'always', query: { source: 'todos', params: { session: 'current' } }, actions: copyAction }
// Carries a due so the deadline decoration ("due 3:29p") is in the row — it must NOT ride into a selection.
const todo: TodoItem = { id: 't1', text: 'Send Dana the signed MSA', due: '2026-07-16T15:29:00Z', createdAt: '2026-07-16T14:40:00Z', provenance: { sessionId: 'ses', distillateId: 'dst-9', dueSource: 'model' } }
const todoNode = render(todoBlock, [todo])

const distBlock: Block = { block: 'distillates', show: 'always', query: { source: 'distillates', params: {} }, actions: copyAction }
const distillate: Distillate = {
  id: 'dst-1', sessionId: 'ses', workspaceId: 'ws',
  windowStart: '2026-07-16T14:20:00Z', windowEnd: '2026-07-16T14:30:00Z',
  sourceChunks: ['c-1'], text: 'Provide feedback to QA within 18 minutes',
  voice: { scope: 'session', dials: { tone: 3, warmth: 4, wit: 2, charm: 2, specificity: 9, brevity: 8 } },
  provenance: { slot: 'llm', endpoint: 'llm.fast' }, schemaVersion: 1, createdAt: '2026-07-16T14:30:00Z',
}
const distNode = render(distBlock, [distillate])

// A user-corrected summary (#246): the corrected prose is the selectable value; the "edited by you" marker
// (.corr) and the why line are decoration and must NOT ride into a selection of the corrected value.
const correctedSummary: Summary = {
  id: 'sum-user-1', workspaceId: 'ws', sessionId: 'ses', level: 'five-minute',
  windowStart: '2026-07-16T14:25:00Z', windowEnd: '2026-07-16T14:30:00Z',
  children: [{ record: 'summary', id: 'r-1', at: '2026-07-16T14:25:00Z', role: 'child', level: 'rolling' }],
  bound: { childrenAvailable: 1, childrenConsumed: 1, evidenceAvailable: 0, evidenceConsumed: 0 },
  text: 'Dana owns the deck; we ship Thursday', proposal: false, source: 'user',
  correction: { at: '2026-07-16T14:31:00Z' }, corrects: 'sum-1', confidence: 1,
  provenance: { builder: 'bounded-hierarchical-summary', windowMs: 300_000, childLevel: 'rolling', templateId: 'tpl-summary-five-minute' },
  revision: 1, schemaVersion: 1, createdAt: '2026-07-16T14:31:00Z',
}
const sumBlock: Block = { block: 'summaries', show: 'always', query: { source: 'summaries', params: { session: 'current', level: 'five-minute' } }, actions: copyAction }
const sumNode = render(sumBlock, [correctedSummary])

test('a native selection of a relevant-now row keeps the bare value only — no why, mark, kind tag, or affordance', () => {
  // The row DISPLAYS its why ("heard · …"), a mark glyph, the kind/mention tag, and a Copy button — none may
  // ride into a selection. The only selectable text is the entity value (here, the full canonical URL).
  assert.equal(selectableText(relNode, suppressed), linkEntity.name)
})

test('a native selection of a todos row keeps the bare to-do text only', () => {
  assert.equal(selectableText(todoNode, suppressed), todo.text)
})

test('a native selection of a distillates (transcript) row keeps the bare value only — the ".from the meeting" defect cannot recur', () => {
  // The exact shape the owner reported: value + adjacent why-line. The why ("from what was captured") and the
  // clock (.mk) are decoration; a selection must yield only the distilled value.
  assert.equal(selectableText(distNode, suppressed), distillate.text)
})

test('a native selection of a user-corrected summary row keeps the bare corrected value only — the "edited by you" marker never rides in', () => {
  // #246: the corrected prose is the value; the .corr marker + the why line are decoration. A selection must
  // yield only the corrected text — never "…edited by you" trailing the value.
  assert.equal(selectableText(sumNode, suppressed), correctedSummary.text)
})

test('the classes this test relies on are non-selectable in the ACTUAL stylesheet (by-construction guard)', () => {
  // Derived from styles.ts / panel-styles.ts, not hardcoded — removing any of these rules fails BOTH this
  // assertion and the equality tests above (the decoration text would leak into selectableText).
  for (const cls of ['why', 'ext', 'due', 'mk', 'glbl', 'go', 'dot', 't', 'unans', 'in-cites', 'in-who', 'corr']) {
    assert.ok(suppressed.has(cls), `.${cls} must be non-selectable`)
  }
})

test('negative probe: were .why NOT suppressed, the why line WOULD leak — proving the guard is load-bearing', () => {
  const weakened = new Set(suppressed)
  weakened.delete('why')
  const leaked = selectableText(relNode, weakened)
  assert.notEqual(leaked, linkEntity.name)
  assert.match(leaked, /heard/) // the why line rejoins the selection exactly when the rule is gone
})
