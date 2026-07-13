import type { QueryResult, SenseLaneSnapshot, Surface } from '@openinfo/contracts'
import { SENSE_LANE_SOURCES, sanitizeSenseLaneSnapshot } from '../sense-lane-snapshot.js'

export { sanitizeSenseLaneSnapshot } from '../sense-lane-snapshot.js'

export interface LiveSensePatchInput {
  surface: Surface
  results: readonly (QueryResult | undefined)[]
  lane: SenseLaneSnapshot
}

const canonicalLanes = (result: QueryResult | undefined): SenseLaneSnapshot[] | undefined => {
  if (result?.source !== 'live-senses' || result.items.length !== SENSE_LANE_SOURCES.length) return undefined
  const lanes = result.items.map(sanitizeSenseLaneSnapshot)
  if (lanes.some((lane) => lane === undefined)) return undefined
  const exact = lanes as SenseLaneSnapshot[]
  if (!SENSE_LANE_SOURCES.every((source, laneIndex) => exact[laneIndex]?.source === source)) return undefined
  const workspaceId = exact[0]!.workspaceId
  const sessionId = exact[0]!.sessionId
  return exact.every((lane) => lane.workspaceId === workspaceId && lane.sessionId === sessionId) ? exact : undefined
}

const sameScope = (left: SenseLaneSnapshot, right: SenseLaneSnapshot): boolean =>
  left.workspaceId === right.workspaceId && left.sessionId === right.sessionId

/** Patch every hydrated live-senses block whose own authenticated scope matches; undefined means ignore. */
export const patchLiveSenseResults = (input: LiveSensePatchInput): (QueryResult | undefined)[] | undefined => {
  let changed = false
  const results = input.results.map((result, index) => {
    if (input.surface.stack[index]?.query?.source !== 'live-senses' || result?.source !== 'live-senses') return result
    const exact = canonicalLanes(result)
    if (!exact || !sameScope(input.lane, exact[0]!)) return result
    const laneIndex = SENSE_LANE_SOURCES.indexOf(input.lane.source)
    const current = exact[laneIndex]!
    if (Date.parse(input.lane.updatedAt) < Date.parse(current.updatedAt)) return result
    const next = [...exact]
    next[laneIndex] = input.lane
    changed = true
    return { ...result, items: next }
  })
  return changed ? results : undefined
}

/**
 * Reconcile a completed query with payload events that may have landed while it was in flight. A query
 * for a different workspace/session is authoritative (session/reconnect scope changed). Within the same
 * exact scope, each physical source keeps the row with the newest updatedAt so an older query snapshot
 * cannot roll live truth backward.
 */
export const reconcileLiveSenseHydration = (
  surface: Surface,
  currentResults: readonly (QueryResult | undefined)[],
  hydratedResults: readonly (QueryResult | undefined)[],
): (QueryResult | undefined)[] => hydratedResults.map((hydrated, index) => {
  if (surface.stack[index]?.query?.source !== 'live-senses') return hydrated
  const incoming = canonicalLanes(hydrated)
  if (!incoming || !hydrated) return hydrated
  const current = canonicalLanes(currentResults[index])
  if (!current || !sameScope(current[0]!, incoming[0]!)) return { ...hydrated, items: incoming }
  const items = incoming.map((row, laneIndex) =>
    Date.parse(current[laneIndex]!.updatedAt) >= Date.parse(row.updatedAt) ? current[laneIndex]! : row,
  )
  return { ...hydrated, items }
})
