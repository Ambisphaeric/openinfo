import { h, type VNode } from '../block-renderer/vnode.js'
import type { BlockRenderer } from '../block-renderer/registry.js'

const LABEL = 'Senses · gates'

/**
 * The `sense-gates` block (#7 on a diagnostics surface, #101) — the per-sense gate chain as a block. The
 * engine already computes ONE named verdict per sense (the FIRST closed gate is the blocker, with a one-step
 * fix); until now it rendered only in Settings → Status and the tray. This block reads the hydrated `senses`
 * query (`source: 'senses'`, one row per sense — the same evaluateSenseGates verdict GET /senses serves,
 * WITHOUT the live endpoint probe: the block re-hydrates often, so the health gate leans on the queue's last
 * classified failure, disclosed in the why-line) and renders: sense · blocking gate + its fix, or all-clear
 * with the chain summarized. Empty is EXPLAINABLE, never silent.
 *
 * The row shapes mirror the engine's SenseGateChain/SenseGate (surfaces/settings/sense-gates.ts) — they ride
 * QueryResult.items as documented on the contract; the client types them structurally here.
 */
interface GateRow {
  id: string
  label: string
  pass: boolean
  fix?: string
  detail?: string
}
interface ChainRow {
  sense: string
  label: string
  gates: GateRow[]
  blocking?: GateRow
}

/** The compact whole-chain summary: every gate's label with its verdict mark, front to back. */
const chainSummary = (gates: GateRow[]): string => gates.map((g) => `${g.label} ${g.pass ? '✓' : '✕'}`).join(' · ')

const senseRow = (chain: ChainRow): VNode => {
  const blocked = chain.blocking
  const mark = blocked === undefined ? '✓' : '✕'
  const title = blocked === undefined ? `${chain.label} — engine-side gates open` : `${chain.label} — blocked: ${blocked.label}`
  const why =
    blocked === undefined
      ? chainSummary(chain.gates)
      : [blocked.fix, blocked.detail].filter((s): s is string => s !== undefined && s !== '').join(' — ') || chainSummary(chain.gates)
  return h(
    'div',
    { class: 'rel' },
    h('span', { class: `mk ${blocked === undefined ? 'q' : 't'}` }, mark),
    h(
      'span',
      { class: 'body' },
      h('span', { class: 'ttl' }, title),
      h('span', { class: 'why' }, why),
    ),
  )
}

const unavailableRow = (): VNode =>
  h(
    'div',
    { class: 'rel' },
    h('span', { class: 'mk t' }, '—'),
    h(
      'span',
      { class: 'body' },
      h('span', { class: 'ttl' }, 'Sense gates unavailable'),
      h('span', { class: 'why' }, 'the engine is not reporting gate chains right now'),
    ),
  )

const scopeRow = (): VNode =>
  h(
    'div',
    { class: 'rel note' },
    h('span', { class: 'mk q' }, 'ⓘ'),
    h(
      'span',
      { class: 'body' },
      h('span', { class: 'ttl' }, 'engine-side gates only'),
      h('span', { class: 'why' }, 'client gates (sense toggle, OS permission, engine reachable) live in the tray Capture status; endpoint health here reads the last classified failure, not a live probe'),
    ),
  )

export const renderSenseGates: BlockRenderer = ({ block, result }) => {
  if (block.collapsed) return h('div', { class: 'hgroup' }, h('div', { class: 'glbl' }, LABEL))
  const chains = (result?.items ?? []) as ChainRow[]
  if (chains.length === 0) return h('div', { class: 'hgroup' }, h('div', { class: 'glbl' }, LABEL), unavailableRow())
  return h('div', { class: 'hgroup' }, h('div', { class: 'glbl' }, LABEL), scopeRow(), ...chains.map(senseRow))
}
