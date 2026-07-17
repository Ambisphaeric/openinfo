import type { Fabric } from '@openinfo/contracts'
import { ALL_SLOTS, escapeHtml, type SetupData } from '../../setup/view.js'
import { evaluateSenseGates, type SenseGate, type SenseGateChain } from '../sense-gates.js'

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

/**
 * The session's episode title, or an honest start-time fallback (#211) — never a raw id. A session with no
 * derived/user title yet reads as "started 2:16 PM" (calm, human), so the row always names the episode in
 * words. The time is the viewer-local clock of the server render, coarse to the minute.
 */
const sessionTitleOrStart = (title: string | undefined, startedAt: string): string => {
  if (title !== undefined && title.trim() !== '') return title
  const at = new Date(startedAt)
  if (Number.isNaN(at.getTime())) return 'just started'
  return `started ${at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}

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

/**
 * The per-sense capture-gate readout (issue #7): for each sense, the ORDERED engine-side gates a
 * captured segment must clear to become something, with the FIRST closed gate named as the blocker and
 * a one-step fix — so a sense never reads as generically dead when a specific gate is the cause. Pure:
 * assembled from flags + live fabric slots + the queue's last classified failure (no probe in the render
 * path — the GET /senses route is where a live health check rides). The client-side gates that precede
 * these (sense toggled off, OS permission, engine reachable) are the tray's; this is the engine's honest
 * half ("given capture is flowing, would a transcript / OCR read come out?").
 */
const gateDot = (gate: SenseGate, isBlocker: boolean): string =>
  isBlocker ? '<span class="stat-dot off">●</span>' : gate.pass ? '<span class="stat-dot on">●</span>' : '<span class="stat-dot off">○</span>'

const senseChainHtml = (chain: SenseGateChain): string => {
  const dots = chain.gates
    .map((g) => `<span class="gate ${g.pass ? 'ok' : chain.blocking?.id === g.id ? 'block' : 'off'}">${gateDot(g, chain.blocking?.id === g.id)}${escapeHtml(g.label)}</span>`)
    .join('')
  const verdict = chain.blocking
    ? `<span class="stat-fail-class">blocked</span> at ${escapeHtml(chain.blocking.label)}`
    : `${dot(true)} clear`
  const fix = chain.blocking?.fix ? `<div class="stat-row"><span class="stat-key">what to do</span><span class="stat-hint">${escapeHtml(chain.blocking.fix)}</span></div>` : ''
  return (
    `<div class="stat-slots"><div class="stat-slot"><span class="stat-slot-key">${escapeHtml(chain.label)}</span>` +
    `<span class="stat-slot-detail">${verdict}</span></div>` +
    `<div class="gate-chain">${dots}</div>${fix}</div>`
  )
}

const captureChainCard = (data: SetupData): string =>
  card(
    'Capture pipeline',
    '<div class="stat-note">Each sense in order — the first closed gate is what blocks it (a session and OS permission come first, on the client).</div>' +
      evaluateSenseGates({
        flags: data.flags ?? [],
        fabric: data.liveFabric,
        ...(data.activeWorkflow ? { activeWorkflow: data.activeWorkflow } : {}),
        ...(data.queue?.lastFailure ? { lastFailure: data.queue.lastFailure } : {}),
      })
        .map(senseChainHtml)
        .join(''),
  )

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
  // #211: name the live session by its episode title (derived from orientation, or a user rename), never the
  // raw id (an id is not a name — hud-voice). Until one is derived, an honest start-time fallback stands in.
  // #226: this line is already scoped to the single default workspace, so the old " in <workspaceId>" clause
  // only leaked the raw id ("… in default") as machinery — omitted (a lone workspace needs no disambiguation).
  const sessionCard = card(
    'Session',
    live
      ? row('live', `${dot(true)} ${escapeHtml(sessionTitleOrStart(live.title, live.startedAt))}`)
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
    captureChainCard(data) +
    '</div>' +
    '<div class="stat-defer">Per-source capture ingress (mic / system-audio / focus, "last heard Ns ago") is a ' +
    'follow-up — the queue exposes only aggregate counts today, so a per-source readout needs engine plumbing. ' +
    'The menu-bar tray shows live recording sources meanwhile.</div>'
  )
}
