import type { Block, PhysicalSenseSource, SenseLaneHealth, SenseLaneSnapshot } from '@openinfo/contracts'
import { clockLabel } from '../block-renderer/format.js'
import type { BlockRenderer } from '../block-renderer/registry.js'
import { h, type VNode } from '../block-renderer/vnode.js'
import { SENSE_LANE_SOURCES, sanitizeSenseLaneSnapshot } from '../sense-lane-snapshot.js'

const LABEL = 'Live senses'

const SOURCE_LABEL: Record<PhysicalSenseSource, string> = {
  mic: 'Microphone',
  'system-audio': 'System audio',
  screen: 'Screen',
}

const DISPOSITION_LABEL: Record<SenseLaneSnapshot['disposition'], string> = {
  stopped: 'Stopped',
  waiting: 'Waiting',
  queued: 'Queued',
  processed: 'Processed',
  'delta-skipped': 'No screen change',
  blank: 'No content found',
  failed: 'Failed',
}

const HEALTH_LABEL: Record<SenseLaneHealth, string> = {
  unknown: 'Status unknown',
  healthy: 'Healthy',
  blocked: 'Blocked',
  failed: 'Needs attention',
}

const HEALTH_MARK: Record<SenseLaneHealth, { glyph: string; tone: string }> = {
  unknown: { glyph: '○', tone: 'p' },
  healthy: { glyph: '●', tone: 'd' },
  blocked: { glyph: '●', tone: 'q' },
  failed: { glyph: '●', tone: 'c' },
}

/**
 * The TRUE reason a blocked lane is blocked, in human words (#192, hud-voice): the engine only ever emits
 * these three closed codes with health `blocked`, each stating what is actually wrong and the one place to
 * fix it — never a flag key, slot name, or error string.
 */
const BLOCKED_REASON_LABEL: Partial<Record<SenseLaneSnapshot['reason'], string>> = {
  disabled: 'Turned off in Settings — nothing captured here is processed until it is back on',
  'permission-denied': 'This capture isn’t allowed yet — grant access in System Settings',
  'configuration-blocked': 'No model is set up for this yet — connect one in Settings',
}

const lagLabel = (lagMs: number): string => {
  if (lagMs < 1_000) return `${lagMs} ms`
  const seconds = lagMs / 1_000
  const value = seconds < 10 ? seconds.toFixed(1).replace(/\.0$/, '') : Math.round(seconds).toString()
  return `${value} s`
}

const timePhrase = (prefix: string, iso: string): string => {
  const time = clockLabel(iso)
  return time === '' ? prefix : `${prefix} ${time}`
}

const detailLine = (lane: SenseLaneSnapshot): string => {
  const details: string[] = []
  // A blocked lane leads with its true blocker (§3 honest states) — capture/processing evidence follows.
  const blockedReason = lane.health === 'blocked' ? BLOCKED_REASON_LABEL[lane.reason] : undefined
  if (blockedReason !== undefined) details.push(blockedReason)
  if (lane.latestCapture) details.push(timePhrase('Last captured', lane.latestCapture.capturedAt))
  if (lane.latestProcessing) {
    const outcome = lane.latestProcessing.outcome === 'processed'
      ? 'Processing complete'
      : lane.latestProcessing.outcome === 'blank'
        ? 'No content found'
        : 'Processing failed'
    details.push(`${outcome} in ${lagLabel(lane.latestProcessing.lagMs)}`)
  }
  if (lane.source === 'screen' && lane.latestObservation) {
    const outcome = lane.latestObservation.outcome === 'delta-skipped'
      ? 'No screen change observed'
      : lane.latestObservation.outcome === 'permission-denied'
        ? 'Capture refused'
        : 'Screen capture failed'
    details.push(timePhrase(outcome, lane.latestObservation.occurredAt))
  }
  return details.length > 0 ? details.join(' · ') : 'No capture yet'
}

const laneRow = (source: PhysicalSenseSource, lane: SenseLaneSnapshot | undefined): VNode => {
  if (!lane) {
    return h(
      'div',
      { class: 'rel sense-lane', 'data-sense-source': source },
      h('span', { class: 'mk p' }, '○'),
      h(
        'span',
        { class: 'body' },
        h('span', { class: 'ttl' }, `${SOURCE_LABEL[source]} · Status unavailable`),
        h('span', { class: 'why' }, 'Waiting for a live snapshot'),
      ),
    )
  }

  const mark = HEALTH_MARK[lane.health]!
  return h(
    'div',
    { class: 'rel sense-lane', 'data-sense-source': source },
    h('span', { class: `mk ${mark.tone}` }, mark.glyph),
    h(
      'span',
      { class: 'body' },
      h('span', { class: 'ttl' }, `${SOURCE_LABEL[source]} · ${DISPOSITION_LABEL[lane.disposition]} · ${HEALTH_LABEL[lane.health]}`),
      h('span', { class: 'why' }, detailLine(lane)),
    ),
  )
}

/**
 * The lanes this block DOCUMENT asked for (#193). The engine caps `live-senses` rows in canonical
 * mic → system-audio → screen order, so a `top` below the full trio (on the query or as the client-side
 * block cap) selects a canonical prefix. Only those lanes paint: a lane the document configured out can
 * never hydrate, and rendering it as an ever-waiting "Status unavailable" row would be a permanent
 * placeholder for data that is not coming. Absent `top` ⇒ the full trio.
 */
const requestedSources = (block: Block): readonly PhysicalSenseSource[] => SENSE_LANE_SOURCES.slice(0, Math.min(
  SENSE_LANE_SOURCES.length,
  block.top ?? SENSE_LANE_SOURCES.length,
  block.query?.top ?? SENSE_LANE_SOURCES.length,
))

/**
 * Compact, human-facing live-sense telemetry. It reads only the closed snapshot fields needed for the
 * glance and deliberately never renders correlation ids, captured content, endpoint/model data, or
 * arbitrary failure text. Source means the physical lane, never an inferred speaker identity.
 */
export const renderSenseLanes: BlockRenderer = ({ block, result }) => {
  if (block.collapsed) return h('div', { class: 'hgroup' }, h('div', { class: 'glbl' }, LABEL))
  const items = (result?.items ?? [])
    .map(sanitizeSenseLaneSnapshot)
    .filter((item): item is SenseLaneSnapshot => item !== undefined)
  return h(
    'div',
    { class: 'hgroup sense-lanes' },
    h('div', { class: 'glbl' }, LABEL),
    ...requestedSources(block).map((source) => laneRow(source, items.find((item) => item.source === source))),
  )
}
