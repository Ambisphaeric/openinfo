import type { Session } from '@openinfo/contracts'
import { h, type VNode } from '../block-renderer/vnode.js'
import type { BlockRenderer } from '../block-renderer/registry.js'
import { clockLabel, elapsedLabel } from '../block-renderer/format.js'

/**
 * The `sessions` block (#211/#177) — the note-taker's session-HISTORY list, the real thing the left rail's
 * Meetings/Archives folders only ever placeheld. It reads the hydrated `sessions` query (`source: 'sessions'`,
 * whole-workspace, newest-started first per store.listSessions) and renders one row per past/live session:
 * its derived-or-user TITLE (#211 resolves latest user → latest derived → an honest start-time fallback,
 * cached on `session.title`), the start TIME, the DATE, and a calm status (a duration once ended, else
 * "in progress"). No session summary is joined here — that needs the `summaries` source, so its presence is
 * deliberately NOT claimed (a follow-up; see the slice issue).
 *
 * READ-ONLY this slice (hud-voice §4 / the interaction-honesty policy): there is no session-detail view to
 * navigate to yet, so rows render as PLAIN ROWS, never as buttons — no fake-live click target, no dead
 * affordance. Click-through is a disclosed follow-up. The block self-labels "Sessions" exactly like the
 * sibling Pinned block, because the note-taker frame renders its rail chrome ABOVE the whole left zone, so a
 * folder header in chrome could never sit adjacent to this list.
 *
 * HONEST STATES (hud-voice §3): empty says what will appear rather than a blank card; the recent window is
 * bounded and any sessions beyond it are disclosed as an honest "N more", never silently dropped.
 */

const LABEL = 'Sessions'

/** Compact local calendar date, e.g. "Jul 16" (viewer-local; `timeZone` override for deterministic tests). */
const dateLabel = (iso: string, timeZone?: string): string => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone }).format(d)
}

/** The resolved title, or an honest start-time fallback — NEVER a raw id (#211). */
const titleOf = (session: Session, timeZone?: string): string => {
  const title = session.title
  if (typeof title === 'string' && title.trim().length > 0) return title
  return `Session · ${dateLabel(session.startedAt, timeZone)}`
}

/** Calm status: a whole-minute duration once the session has ended, else that it is still running. */
const statusOf = (session: Session, timeZone?: string): string => {
  const when = session.endedAt !== undefined ? elapsedLabel(session.startedAt, new Date(session.endedAt)) : 'in progress'
  // A titled row already names itself, so the date belongs in the why; a fallback-titled row carries the
  // date IN its title, so the why stays status-only — no line repeats the date.
  const titled = typeof session.title === 'string' && session.title.trim().length > 0
  return titled ? `${dateLabel(session.startedAt, timeZone)} · ${when}` : when
}

const sessionRow = (session: Session, timeZone?: string): VNode =>
  h(
    'div',
    { class: 'rel' },
    h('span', { class: 'mk t' }, clockLabel(session.startedAt, timeZone)),
    h(
      'span',
      { class: 'body' },
      h('span', { class: 'ttl' }, titleOf(session, timeZone)),
      h('span', { class: 'why' }, statusOf(session, timeZone)),
    ),
  )

const emptyRow = (): VNode =>
  h(
    'div',
    { class: 'rel' },
    h('span', { class: 'mk t' }, '—'),
    h(
      'span',
      { class: 'body' },
      h('span', { class: 'ttl' }, 'No sessions yet'),
      h('span', { class: 'why' }, 'your recorded sessions appear here'),
    ),
  )

/** The honest "beyond the recent window" line — a plain note, never a session row or a click target. */
const moreRow = (hidden: number, atCap: boolean): VNode => {
  const noun = hidden === 1 && !atCap ? 'session' : 'sessions'
  return h(
    'div',
    { class: 'rel' },
    h('span', { class: 'mk t' }, '⋯'),
    h('span', { class: 'body' }, h('span', { class: 'why' }, `${hidden}${atCap ? '+' : ''} earlier ${noun} in history`)),
  )
}

export const renderSessions: BlockRenderer = ({ block, result }) => {
  const all = (result?.items ?? []) as Session[]
  if (all.length === 0) return h('div', { class: 'hgroup' }, h('div', { class: 'glbl' }, LABEL), emptyRow())
  const shown = block.top !== undefined ? all.slice(0, block.top) : all
  const rows: VNode[] = shown.map((s) => sessionRow(s))
  // Sessions beyond the recent window are disclosed, not dropped. `result.truncated` (#66 cap) means more
  // existed past the fetched superset, so the count is a floor ("N+"); otherwise it is exact.
  const hidden = all.length - shown.length
  if (hidden > 0 || result?.truncated === true) rows.push(moreRow(Math.max(hidden, 0), result?.truncated === true))
  return h('div', { class: 'hgroup' }, h('div', { class: 'glbl' }, LABEL), ...rows)
}
