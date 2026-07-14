import type { QueryResult, SenseLaneSnapshot, Surface } from '@openinfo/contracts'
import { SENSE_LANE_SOURCES, sanitizeSenseLaneSnapshot } from '../sense-lane-snapshot.js'

export { sanitizeSenseLaneSnapshot } from '../sense-lane-snapshot.js'

export interface LiveSensePatchInput {
  surface: Surface
  results: readonly (QueryResult | undefined)[]
  lane: SenseLaneSnapshot
}

/**
 * Sanitize a hydrated `live-senses` result into its closed lane rows. The full trio is not required
 * (#193): the engine caps rows in canonical mic → system-audio → screen order, so a block whose query
 * asks for fewer lanes hydrates a canonical-order SUBSET — still every row rebuilt through the strict
 * snapshot boundary, still strictly canonical order with no duplicates, still one uniform
 * workspace/session scope. Empty results stay undefined: with no hydrated row there is no
 * authenticated scope for a payload to match, so a cold block never accepts patches.
 */
const hydratedLanes = (result: QueryResult | undefined): SenseLaneSnapshot[] | undefined => {
  if (result?.source !== 'live-senses' || result.items.length === 0 || result.items.length > SENSE_LANE_SOURCES.length) return undefined
  const lanes = result.items.map(sanitizeSenseLaneSnapshot)
  if (lanes.some((lane) => lane === undefined)) return undefined
  const exact = lanes as SenseLaneSnapshot[]
  const order = exact.map((lane) => SENSE_LANE_SOURCES.indexOf(lane.source))
  if (!order.every((sourceIndex, position) => sourceIndex > (position > 0 ? order[position - 1]! : -1))) return undefined
  const workspaceId = exact[0]!.workspaceId
  const sessionId = exact[0]!.sessionId
  return exact.every((lane) => lane.workspaceId === workspaceId && lane.sessionId === sessionId) ? exact : undefined
}

const sameScope = (left: SenseLaneSnapshot, right: SenseLaneSnapshot): boolean =>
  left.workspaceId === right.workspaceId && left.sessionId === right.sessionId

/**
 * Patch every hydrated live-senses block whose own authenticated scope matches; undefined means ignore.
 * Patching is per PHYSICAL SOURCE (#193): a sub-trio block keeps the live fast path for every source it
 * hydrated, and a source the query never returned is never patched IN — hydration alone decides which
 * rows exist, an event can only refresh one of them.
 */
export const patchLiveSenseResults = (input: LiveSensePatchInput): (QueryResult | undefined)[] | undefined => {
  let changed = false
  const results = input.results.map((result, index) => {
    if (input.surface.stack[index]?.query?.source !== 'live-senses' || result?.source !== 'live-senses') return result
    const hydrated = hydratedLanes(result)
    if (!hydrated || !sameScope(input.lane, hydrated[0]!)) return result
    const laneIndex = hydrated.findIndex((row) => row.source === input.lane.source)
    if (laneIndex === -1) return result
    const current = hydrated[laneIndex]!
    if (Date.parse(input.lane.updatedAt) < Date.parse(current.updatedAt)) return result
    const next = [...hydrated]
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
 * cannot roll live truth backward. Rows match by PHYSICAL SOURCE, not by position (#193): a sub-trio
 * hydration reconciles the sources it carries, and the fresh query is authoritative for WHICH sources
 * exist — a source it no longer returns is dropped, never resurrected from the old cache.
 */
export const reconcileLiveSenseHydration = (
  surface: Surface,
  currentResults: readonly (QueryResult | undefined)[],
  hydratedResults: readonly (QueryResult | undefined)[],
): (QueryResult | undefined)[] => hydratedResults.map((hydrated, index) => {
  if (surface.stack[index]?.query?.source !== 'live-senses') return hydrated
  const incoming = hydratedLanes(hydrated)
  if (!incoming || !hydrated) return hydrated
  const current = hydratedLanes(currentResults[index])
  if (!current || !sameScope(current[0]!, incoming[0]!)) return { ...hydrated, items: incoming }
  const items = incoming.map((row) => {
    const held = current.find((laneRow) => laneRow.source === row.source)
    return held !== undefined && Date.parse(held.updatedAt) >= Date.parse(row.updatedAt) ? held : row
  })
  return { ...hydrated, items }
})
