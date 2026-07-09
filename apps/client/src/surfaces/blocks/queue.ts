import type { BacklogEta, QueueStatus } from '@openinfo/contracts'
import { h, type VNode } from '../block-renderer/vnode.js'
import type { BlockRenderer } from '../block-renderer/registry.js'

const LABEL = 'Queue · status'

/**
 * The `queue` block — the honest backlog + last failure on a panel (#13). It reads the hydrated `queue`
 * query (`source: 'queue'`, ONE row: the whole QueueStatus snapshot the engine injects from spool.ts —
 * this source is operational engine state, not a store record) and renders the real telemetry: per-kind
 * backlog depth, the ETA (honest about `basis` — never a fabricated number), the overflow policy + whether
 * v0 enforces it, and — MOST prominently — the last drain failure as VISIBLE text. The failure line is the
 * whole point: the drain no longer re-queues silently forever, so a backlog/failure must never render as an
 * empty or silent block (ARCHITECTURE §7 / the honest-failure mandate). A failure carries its class,
 * endpoint, one-line fix hint, and (when present) the server's own verbatim message. An idle, failure-free
 * queue still renders its status (a status panel is never silent); a block with no status row at all (the
 * queue unwired — only in a unit caller) renders an explainable "status unavailable" line.
 */
const etaLine = (eta: BacklogEta): string => {
  if (eta.basis === 'none') return 'ETA · not enough data yet' // an unknown is unknown — never invented
  if (eta.etaMs !== undefined && eta.etaMs <= 0) return 'ETA · caught up'
  const secs = eta.etaMs !== undefined ? Math.round(eta.etaMs / 1000) : undefined
  return secs !== undefined ? `ETA · ~${secs}s to clear` : 'ETA · clearing'
}

const backlogLine = (status: QueueStatus): string => {
  if (!status.byKind) return `${status.pendingFiles} file${status.pendingFiles === 1 ? '' : 's'} pending`
  const { audio, screen, 'llm-work': llmWork } = status.byKind
  return `backlog · audio ${audio.pendingChunks} · screen ${screen.pendingChunks} · llm-work ${llmWork.pendingChunks}`
}

const failureRow = (status: QueueStatus): VNode | null => {
  const failure = status.lastFailure
  if (!failure) return null
  const server = failure.serverMessage !== undefined ? ` — "${failure.serverMessage}"` : ''
  return h(
    'div',
    { class: 'rel fail' },
    h('span', { class: 'mk x' }, '⚠'),
    h(
      'span',
      { class: 'body' },
      h('span', { class: 'ttl' }, `last failure · ${failure.class} · ${failure.endpoint}${server}`),
      h('span', { class: 'why' }, failure.hint),
    ),
  )
}

const statusRow = (status: QueueStatus): VNode => {
  const overflow = status.overflow
    ? ` · overflow ${status.overflow.policy}${status.overflow.enforced ? '' : ' (declared)'}`
    : ''
  return h(
    'div',
    { class: 'rel' },
    h('span', { class: 'mk q' }, '⧗'),
    h(
      'span',
      { class: 'body' },
      h('span', { class: 'ttl' }, backlogLine(status)),
      h('span', { class: 'why' }, `${status.eta ? etaLine(status.eta) : 'ETA · unknown'}${overflow}`),
    ),
  )
}

const unavailableRow = (): VNode =>
  h(
    'div',
    { class: 'rel' },
    h('span', { class: 'mk q' }, '⧗'),
    h(
      'span',
      { class: 'body' },
      h('span', { class: 'ttl' }, 'Queue status unavailable'),
      h('span', { class: 'why' }, 'the queue is not reporting status right now'),
    ),
  )

export const renderQueue: BlockRenderer = ({ block, result }) => {
  if (block.collapsed) return h('div', { class: 'hgroup' }, h('div', { class: 'glbl' }, LABEL))
  const status = (result?.items ?? [])[0] as QueueStatus | undefined
  const rows: VNode[] = status !== undefined
    ? [statusRow(status), ...(failureRow(status) !== null ? [failureRow(status) as VNode] : [])]
    : [unavailableRow()]
  return h('div', { class: 'hgroup' }, h('div', { class: 'glbl' }, LABEL), ...rows)
}
