import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Action, Surface } from '@openinfo/contracts'
import { renderToHtml, WIRED_VERBS, type NowContext } from '../block-renderer/index.js'
import { defaultBlockRegistry } from './index.js'
import { rowAffordances } from './actions.js'
import { h } from '../block-renderer/vnode.js'
import { renderNotetaker } from '../hud/notetaker-layout.js'
import { INPUT_SUBMIT_VERB } from '../hud/input-submit.js'

/**
 * The machine-speak INTERACTION LINT — the sibling of the register lint (#118) and the enforcement arm of
 * the adopted honesty policy: rendering an affordance with NO live handler is a FAILING test. Where the
 * register lint guards what a block SAYS (no machine ids at a human tier), this guards what a block DOES:
 * every rendered `<button>` must be HONEST about whether it can act. A button is honest iff it is one of —
 *   1. WIRED — its `data-verb` is a verb the mount layer (mount.ts wireActions) or the input-submit module
 *      actually dispatches, so a click does something; or
 *   2. GHOST — it carries the renderer's visible-but-inert marker (`ghost`), the #15/#66 convention for a
 *      verb with no write path this slice (open/pin/mark-for-follow-up) — visibly styled as non-acting; or
 *   3. DISABLED — it carries the `disabled` attribute (the chrome disabled-with-disclosure pattern), so the
 *      OS paints it non-interactive and it never receives a click (the note-taker Record/nav affordances).
 * A button that is none of these — a normal-looking, enabled control with no wired verb — is a SILENT DEAD
 * BUTTON (it invites a click and does nothing, disclosing nothing), and it FAILS the lint. This is exactly
 * the note-taker Record button's old failure mode (a live-looking button whose only disclosure was a hover
 * tooltip), which S3 fixes to the disabled-with-inline-disclosure pattern this lint now blesses.
 */

// The verbs with a real dispatch path, read STRAIGHT FROM the production source of truth: the mount layer's
// WIRED_VERBS (mount.ts wireActions gates on it) unioned with the input block's own verb (input-submit.ts).
// No hand-maintained copy — a verb wired (or unwired) in production moves this set with it, so the lint can
// never drift into false-positiving a new verb or silently blessing a button whose verb was un-wired.
const LIVE_VERBS = new Set<string>([...WIRED_VERBS, INPUT_SUBMIT_VERB])

/** Every `<button …>` opening tag in a rendered HTML string. */
const buttonTags = (html: string): string[] => html.match(/<button\b[^>]*>/g) ?? []

const hasDisabled = (tag: string): boolean => /\sdisabled(?=[\s>])/.test(tag)
const classList = (tag: string): string[] => (tag.match(/\bclass="([^"]*)"/)?.[1] ?? '').split(/\s+/).filter(Boolean)
const dataVerb = (tag: string): string | null => tag.match(/\bdata-verb="([^"]*)"/)?.[1] ?? null

const isHonest = (tag: string): boolean =>
  hasDisabled(tag) || classList(tag).includes('ghost') || (dataVerb(tag) !== null && LIVE_VERBS.has(dataVerb(tag)!))

/** The silent dead buttons in a rendered fragment — a live-looking control with no wired verb. */
const silentDeadButtons = (html: string): string[] => buttonTags(html).filter((tag) => !isHonest(tag))

test('the honesty predicate blesses S3’s disabled-with-disclosure pattern and every honest affordance', () => {
  // A disabled chrome button (the S3 Record fix): non-interactive, discloses itself → honest.
  assert.deepEqual(silentDeadButtons('<button class="nt-record pending" data-nt="record" disabled>Record</button>'), [])
  // A ghost block button (open/pin have no write path this slice): visibly-inert marker → honest.
  assert.deepEqual(silentDeadButtons('<button class="mini ghost" data-verb="open">Open</button>'), [])
  // A wired verb: a real dispatch path → honest.
  assert.deepEqual(silentDeadButtons('<button class="mini" data-verb="copy" data-copy="x">Copy</button>'), [])
  // A disabled nav tab (the note-taker rail chrome) → honest even without a data-verb.
  assert.deepEqual(silentDeadButtons('<button class="nt-navitem active" data-nt="nav-notes" disabled>Notes</button>'), [])
})

test('the interaction lint FAILS a silent dead button — a live-looking control with no live handler', () => {
  // The note-taker Record button's OLD failure mode: enabled, live-looking, only a hover tooltip → CAUGHT.
  const oldRecord = '<button class="nt-record pending" data-nt="record" title="controlled from the tray">Record</button>'
  assert.equal(silentDeadButtons(oldRecord).length, 1)
  // A dead verb rendered as if it were live (a `.mini` with no ghost marker, verb the mount layer ignores).
  const fakeLive = '<button class="mini" data-verb="open">Open</button>'
  assert.equal(silentDeadButtons(fakeLive).length, 1)
})

test('the action renderer NEVER emits a silent dead button, for any verb — wired, unwired text, or glyph', () => {
  // The full verb spectrum: the wired text/glyph verbs plus every unwired one the mount layer still ignores
  // (open/navigate/run-mode/draft-with as text; pin/mark-for-follow-up as glyphs). Rendered with NO write
  // payloads, so the wired-but-payloadless verbs fall to their inert form too — the hardest honesty case.
  const verbs = ['copy', 'open', 'mark-done', 'accept', 'navigate', 'run-mode', 'draft-with', 'dismiss', 'pin', 'mark-for-follow-up']
  const actions: Action[] = verbs.map((verb, i) => ({ id: `a${i}`, label: verb, verb, params: {} }) as Action)

  const bare = renderToHtml(h('span', {}, ...rowAffordances(actions, 'copy-text', {})))
  assert.deepEqual(silentDeadButtons(bare), [], 'every affordance is live-verb, ghost, or disabled')

  // With the write payloads present, the wired verbs render LIVE (non-ghost) — still no dishonest button, and
  // the payloaded verbs are dispatchable, confirming the honest side of the predicate is reachable, not vacuous.
  const wired = renderToHtml(
    h(
      'span',
      {},
      ...rowAffordances(actions, 'copy-text', {
        markDone: { sessionId: 's', todoId: 't' },
        accept: { workspaceId: 'w', pattern: { field: 'windowTitle', contains: 'x', weight: 1 } },
        dismiss: { workspaceId: 'w', source: 'todos', itemId: 't' },
      }),
    ),
  )
  assert.deepEqual(silentDeadButtons(wired), [])
  assert.match(wired, /class="mini" data-verb="mark-done"/) // wired verb rendered live (no ghost)
})

test('the served note-taker frame is honest end-to-end: Record + rail chrome carry no silent dead button', () => {
  // Render the ACTUAL note-taker frame (renderNotetaker) — its hand-rolled chrome (home, feature nav, and the
  // relocated Record button) is not a block, so only THIS driven render exercises it. An empty stack is enough:
  // the chrome renders regardless of data, and the block affordances are covered by the renderer test above.
  const now: NowContext = { live: true, workspace: 'acme', title: 'Renewal — security review' }
  const surface: Surface = { id: 'surf-openinfo-notetaker', name: 'Note-taker', context: 'meeting', version: 1, stack: [] }
  const html = renderToHtml(renderNotetaker({ surface, now, results: [] }, defaultBlockRegistry))

  assert.match(html, /class="nt-record pending"[^>]*disabled/) // the Record button is honestly disabled
  assert.deepEqual(silentDeadButtons(html), []) // …and no chrome button invites a dead click
})
