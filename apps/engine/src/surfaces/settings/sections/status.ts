import type { Fabric } from '@openinfo/contracts'
import { ALL_SLOTS, escapeHtml, type SetupData } from '../../setup/view.js'

/**
 * The Status section — an at-a-glance readout of the live engine, assembled ENTIRELY from data the
 * engine already holds (no new probes, per the slice brief). It answers the friend's "is anything
 * actually on?" question in one place: engine uptime, the active profile + per-slot endpoint
 * occupancy, how many features are on, the live session if any, and the capture queue.
 *
 * v1 scope: the audio-capture research doc sketches a per-source last-ingress readout (mic/system/
 * focus, "last heard 3s ago"). That needs new engine plumbing (the QueueStatus contract carries only
 * aggregate pending/drained counts, not per-source timestamps), so it is deferred and noted here as a
 * follow-up rather than faked.
 */

/** Human uptime from ms ("3h 12m", "6m", "48s") — honest, coarse, no library. */
const humanUptime = (ms: number): string => {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

/** A ● (occupied/on) or ○ (empty/off) status dot with a class for colour. */
const dot = (on: boolean): string => `<span class="stat-dot ${on ? 'on' : 'off'}">${on ? '●' : '○'}</span>`

/** One per-slot occupancy line — how many endpoints the live fabric wires into each slot. */
const slotLinesHtml = (fabric: Fabric): string =>
  ALL_SLOTS.map((slot) => {
    const eps = fabric.slots[slot]
    const names = eps.map((e) => e.name).join(', ')
    const detail = eps.length ? `${eps.length} · ${escapeHtml(names)}` : 'empty'
    return `<div class="stat-slot">${dot(eps.length > 0)}<span class="stat-slot-key">${escapeHtml(slot)}</span><span class="stat-slot-detail">${detail}</span></div>`
  }).join('')

/** A labelled status card: a title + rows of key/value. */
const card = (title: string, rows: string): string =>
  `<div class="card stat-card"><div class="stat-title">${escapeHtml(title)}</div>${rows}</div>`

const row = (label: string, value: string): string =>
  `<div class="stat-row"><span class="stat-key">${escapeHtml(label)}</span><span class="stat-val">${value}</span></div>`

/** The Status section body. Pure — reads only fields the shell already assembled. */
export const renderStatus = (data: SetupData): string => {
  const flags = data.flags ?? []
  const onCount = flags.filter((f) => f.default === true).length
  const active = data.activeId ? data.profiles.find((p) => p.id === data.activeId) : undefined
  const llmOn = data.liveFabric.slots.llm.length > 0

  const engineCard = card(
    'Engine',
    row('reachable', `${dot(true)} up${data.uptimeMs !== undefined ? ` · ${humanUptime(data.uptimeMs)}` : ''}`) +
      row('llm configured', llmOn ? `${dot(true)} yes — distillation can run` : `${dot(false)} no — nothing can distill yet`),
  )

  const profileCard = card(
    'Active profile',
    (active
      ? row('profile', `${escapeHtml(active.name)} <span class="stat-mono">${escapeHtml(active.id)} · v${active.version}</span>`)
      : row('profile', `${dot(false)} none active — editing the live fabric directly`)) +
      `<div class="stat-slots">${slotLinesHtml(data.liveFabric)}</div>`,
  )

  const featuresCard = card(
    'Features',
    row('flags on', `${dot(onCount > 0)} ${onCount} of ${flags.length} on`) +
      '<div class="stat-note"><a href="/settings/features">Compose features →</a></div>',
  )

  const live = data.liveSession
  const sessionCard = card(
    'Session',
    live
      ? row('live', `${dot(true)} session <span class="stat-mono">${escapeHtml(live.id)}</span> in ${escapeHtml(live.workspaceId)}${live.title ? ` · ${escapeHtml(live.title)}` : ''}`)
      : row('live', `${dot(false)} no live session`),
  )

  const q = data.queue
  const f = q?.lastFailure
  // The honest drain readout (INVOKE-RESILIENCE): pending/drained AND the last classified failure with its
  // troubleshoot hint — so "nothing is arriving" always has a visible, actionable reason (never silent).
  const failureRows = f
    ? row('last failure', `<span class="stat-dot off">●</span> <span class="stat-fail-class">${escapeHtml(f.class)}</span> on ${escapeHtml(f.endpoint)}${f.model ? ` <span class="stat-mono">${escapeHtml(f.model)}</span>` : ''}`) +
      row('what to do', `<span class="stat-hint">${escapeHtml(f.hint)}</span>`)
    : q?.lastSuccessAt
      ? row('last drain', `${dot(true)} ok`)
      : ''
  const queueCard = card(
    'Capture queue',
    q
      ? row('pending', `${q.pendingFiles} file${q.pendingFiles === 1 ? '' : 's'} · ${q.pendingBytes} bytes`) +
          row('drained', `${q.drainedFiles} file${q.drainedFiles === 1 ? '' : 's'}`) +
          failureRows
      : row('queue', 'no queue activity yet'),
  )

  return (
    '<div class="sub">What openinfo is doing right now — assembled from live engine state.</div>' +
    '<div class="stat-grid">' +
    engineCard +
    profileCard +
    featuresCard +
    sessionCard +
    queueCard +
    '</div>' +
    '<div class="stat-defer">Per-source capture ingress (mic / system-audio / focus, "last heard Ns ago") is a ' +
    'follow-up — the queue exposes only aggregate counts today, so a per-source readout needs engine plumbing ' +
    'The menu-bar tray shows live recording sources meanwhile.</div>'
  )
}
