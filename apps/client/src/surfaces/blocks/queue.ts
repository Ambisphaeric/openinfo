import type { BacklogEta, QueueStatus } from '@openinfo/contracts'
import { h, type VNode } from '../block-renderer/vnode.js'
import type { BlockRenderArgs, BlockRenderer } from '../block-renderer/registry.js'

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

/**
 * The delay-disclosure threshold (#102 keep-time), in ms. Below this we render NOTHING — a sub-threshold
 * lag is normal pipeline slack, not a delay worth announcing; above it, the block honestly says how far
 * behind the present the data is. Overridable per surface via the block query params (`lagThresholdMs`) —
 * the smallest honest configurability, no new settings framework (that is design-session territory, #102
 * item 4). Default 5s: long enough that ordinary drain jitter stays silent, short enough that a real
 * backlog surfaces before delayed data could be mistaken for the present.
 */
const DEFAULT_LAG_THRESHOLD_MS = 5000

const lagThresholdOf = (block: BlockRenderArgs['block']): number => {
  const override = block.query?.params?.['lagThresholdMs']
  return typeof override === 'number' && Number.isFinite(override) && override >= 0 ? override : DEFAULT_LAG_THRESHOLD_MS
}

/**
 * The honest delay line (#102): "processing ~Ns behind", rendered ONLY when the backward-looking lag is a
 * measured `capture-time` value AT OR ABOVE the threshold. `unknown` basis claims nothing (we never invent
 * a lag we couldn't measure); caught up (lag absent) renders nothing. This is the visible half of the
 * guarantee that delayed data is never presented as real-time.
 */
const lagDisclosure = (status: QueueStatus, thresholdMs: number): string | null => {
  const lag = status.lag
  if (!lag || lag.basis !== 'capture-time' || lag.behindMs < thresholdMs) return null
  return `processing ~${Math.round(lag.behindMs / 1000)}s behind`
}

const lagRow = (status: QueueStatus, thresholdMs: number): VNode | null => {
  const line = lagDisclosure(status, thresholdMs)
  if (line === null) return null
  return h(
    'div',
    { class: 'rel lag' },
    h('span', { class: 'mk q' }, '⏱'),
    h(
      'span',
      { class: 'body' },
      h('span', { class: 'ttl' }, line),
      h('span', { class: 'why' }, 'delayed capture is appended with its true time, never shown as now'),
    ),
  )
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
    ? [
        statusRow(status),
        ...(lagRow(status, lagThresholdOf(block)) !== null ? [lagRow(status, lagThresholdOf(block)) as VNode] : []),
        ...(failureRow(status) !== null ? [failureRow(status) as VNode] : []),
      ]
    : [unavailableRow()]
  return h('div', { class: 'hgroup' }, h('div', { class: 'glbl' }, LABEL), ...rows)
}
