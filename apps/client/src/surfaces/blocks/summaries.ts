import type { Block, Summary } from '@openinfo/contracts'
import { h, type VNode } from '../block-renderer/vnode.js'
import type { BlockRenderer, SummaryEditRenderContext } from '../block-renderer/registry.js'
import { clockLabel } from '../block-renderer/format.js'
import { actionButtons } from './actions.js'

type Actions = NonNullable<Block['actions']>

const LABEL = 'Summary'

/**
 * The correction verbs (#246) — the in-place edit affordance on a summary row. All three are dispatched by
 * the SummaryEditSession controller (hud/summary-correct.ts), NOT the generic mount layer, so they are
 * exported as the source of truth: the honesty interaction lint UNIONS them (exactly as it unions
 * `INPUT_SUBMIT_VERB`) so a rendered edit affordance is never a silent dead button, and the controller
 * imports them to gate its delegated listeners. `SUMMARY_EDIT_VERB` opens the inline editor (client-local),
 * `SUMMARY_CANCEL_VERB` closes it (client-local), `SUMMARY_CORRECT_VERB` posts the correction (a write).
 */
export const SUMMARY_EDIT_VERB = 'summary-edit'
export const SUMMARY_CANCEL_VERB = 'summary-edit-cancel'
export const SUMMARY_CORRECT_VERB = 'summary-correct'
export const SUMMARY_EDIT_VERBS: readonly string[] = [SUMMARY_EDIT_VERB, SUMMARY_CANCEL_VERB, SUMMARY_CORRECT_VERB]

/**
 * The `summaries` block (#177 slice 2) — the human headline the default HUD leads with. It reads the
 * hydrated `summaries` query (`source: 'summaries'`, one level via params.level, newest window first) and
 * renders one row per Summary: the model-PROPOSED prose with its clock label and a `.why` line phrased for a
 * HUMAN (hud-voice §2) — what the row is ("a summary of what's been said"), never the endpoint/model id or a
 * raw confidence score. Sentence-level (distillate-stream) processing is NOT here — it lives on the
 * Diagnostics/Fields surfaces; the human surface leads with the five-minute and session VIEW, not every
 * sentence (#177 acceptance).
 *
 * CORRECTABLE IN PLACE (#246): the why-line promises "a draft you can correct" — so on a surface that
 * supports it (the `summaryEdit` context is threaded), a live row grows a small pencil affordance that swaps
 * the row to an editable field; saving posts a SOVEREIGN user correction (feedback that visibly takes
 * effect — hud-voice §5). A corrected row is marked honestly as your own edit, not a draft. A degraded or
 * empty row gets NO edit affordance (there is nothing yet to correct — connect a model first).
 *
 * HONEST DEGRADED (hud-voice §3): a summary whose model was unavailable carries NO prose — it renders a calm
 * "Summary unavailable — no summary model connected" line, never fabricated text, with the recorded machine
 * reason available on inspection (title) rather than in glance position. Empty is EXPLAINABLE, not silent.
 */

/** Human level labels (hud-voice §2: no jargon in glance position) — the timescale the row speaks to. */
const levelLabel = (level: Summary['level']): string =>
  level === 'five-minute'
    ? 'Last five minutes'
    : level === 'session'
      ? 'This session'
      : level === 'episode'
        ? 'This stretch'
        : level === 'project'
          ? 'Project so far'
          : 'Just now'

/** True ⇒ this summary is a sovereign user correction (its prose is human-authored, not a model proposal). */
const isUserCorrected = (summary: Summary): boolean => summary.source === 'user'

/**
 * The inline editor for one summary row (#246) — the row swaps to an editable field when the user opens it.
 * A textarea prefilled with the current prose, a live Save + Cancel, and an empty `.sum-status` region the
 * controller paints an HONEST failure line into (compose-after-render, matching the input block's
 * `.in-status`). The Save button carries the write payload (workspace + summary id) as data-attributes; the
 * controller reads the TYPED text off the textarea at save time (a value is not knowable at render). Verbs
 * are live (dispatched by the controller), so no affordance here is a silent dead button.
 */
const editRow = (summary: Summary): VNode =>
  h(
    'div',
    { class: 'rel sum-editing' },
    h('span', { class: 'mk t' }, clockLabel(summary.windowEnd)),
    h(
      'span',
      { class: 'body' },
      h('textarea', { class: 'sum-edit-text', 'data-summary': summary.id, rows: 3, 'aria-label': 'Edit this summary' }, summary.text!),
      // The controller fills this with a calm failure line if the save is refused; empty until then.
      h('span', { class: 'sum-status' }),
      h(
        'span',
        { class: 'sum-edit-actions' },
        h('button', { class: 'mini', 'data-verb': SUMMARY_CORRECT_VERB, 'data-summary': summary.id, 'data-workspace': summary.workspaceId }, 'Save'),
        h('button', { class: 'mini ghost', 'data-verb': SUMMARY_CANCEL_VERB, 'data-summary': summary.id }, 'Cancel'),
      ),
    ),
  )

/** The pencil affordance that opens the inline editor — a glyph-scale `.gverb` (the #66 idiom), live (client-local). */
const editGlyph = (summary: Summary): VNode =>
  h(
    'button',
    { class: 'gverb sum-edit-open', 'data-verb': SUMMARY_EDIT_VERB, 'data-summary': summary.id, title: 'Edit this summary' },
    '✎',
  )

const summaryRow = (summary: Summary, actions: Actions, edit?: SummaryEditRenderContext): VNode => {
  const degraded = summary.text === undefined
  // The edit affordance is opt-in: it renders only where a surface threaded the correction context (so it is
  // never a dead button), and never on a degraded/empty row (nothing to correct until a model connects).
  const canEdit = edit !== undefined && !degraded
  if (canEdit && edit!.editing === summary.id) return editRow(summary)

  const body = degraded ? 'Summary unavailable — no summary model connected' : summary.text!
  const corrected = isUserCorrected(summary)
  // The prose is a PROPOSAL (#189) — say so plainly (a line the user can correct), never assert it as truth.
  // A corrected row is the user's OWN text, so it is no longer "a draft" — the why names the timescale only.
  const why = degraded
    ? 'nothing invented — connect a model to summarize'
    : corrected
      ? levelLabel(summary.level)
      : `${levelLabel(summary.level)} · a draft you can correct`
  return h(
    'div',
    { class: 'rel' },
    h('span', { class: 'mk t' }, clockLabel(summary.windowEnd)),
    h(
      'span',
      { class: 'body' },
      h('span', { class: 'ttl' }, body),
      // The recorded machine reason stays reachable on inspection (hud-voice §4), never in glance position.
      h('span', degraded && summary.degraded ? { class: 'why', title: summary.degraded.reason } : { class: 'why' }, why),
      // The honest correction marker (#246): a small decoration saying this prose is your own edit, so a
      // correction visibly takes effect (hud-voice §5). It is DECORATION — user-select:none (see styles.ts /
      // selection-hygiene) so it never rides into a copied selection of the corrected value.
      corrected ? h('span', { class: 'corr' }, 'edited by you') : undefined,
    ),
    // A degraded row has NO value to copy — suppress the copy affordance entirely rather than shipping a
    // live Copy button that puts an empty string on the clipboard (#242). Live rows copy the prose (the
    // CORRECTED prose once corrected — copy stays value-only). The pencil rides beside it where supported.
    h('span', { class: 'go' }, ...(degraded ? [] : [...actionButtons(actions, summary.text!), ...(canEdit ? [editGlyph(summary)] : [])])),
  )
}

/**
 * Empty is EXPLAINABLE, not silent — and honest about WHY (#215/#227/hud-voice). The summaries source is
 * session-scoped, so it carries the `noCurrentSession` disclosure (#210) like its siblings: with NO session
 * live this process the summary is empty because nothing is being captured — stay session-first (start one).
 * With a session live but no summary, the dominant cause on a fresh install is that the summary timeline is
 * OFF (`summaries.enabled` defaults OFF, enabled out-of-surface in Settings → Features), so the line NAMES
 * that toggle and where it lives. The renderer is pure and cannot read the runtime flag, so it names the
 * enablement PATH, not off vs on (the fields.ts pattern) — human copy, never the raw flag key.
 */
const emptyRow = (noSession: boolean): VNode => {
  const [title, why] = noSession
    ? ['No session running', 'a summary appears here once you start a session']
    : ['No summary yet', 'turn on “Build a summary timeline” in Settings → Features — a summary builds as the session runs']
  return h(
    'div',
    { class: 'rel' },
    h('span', { class: 'mk t' }, '—'),
    h(
      'span',
      { class: 'body' },
      h('span', { class: 'ttl' }, title),
      h('span', { class: 'why' }, why),
    ),
  )
}

export const renderSummaries: BlockRenderer = ({ block, result, summaryEdit }) => {
  if (block.collapsed) return h('div', { class: 'hgroup' }, h('div', { class: 'glbl' }, LABEL))
  const actions = block.actions ?? []
  const all = (result?.items ?? []) as Summary[]
  const rows = block.top !== undefined ? all.slice(0, block.top) : all
  const nodes: VNode[] = rows.length > 0 ? rows.map((s) => summaryRow(s, actions, summaryEdit)) : [emptyRow(result?.noCurrentSession === true)]
  return h('div', { class: 'hgroup' }, h('div', { class: 'glbl' }, LABEL), ...nodes)
}
