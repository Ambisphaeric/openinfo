import type {
  PhysicalSenseSource,
  ScreenLaneObservation,
  SenseLaneCapture,
  SenseLaneDisposition,
  SenseLaneHealth,
  SenseLaneProcessing,
  SenseLaneReason,
  SenseLaneSnapshot,
} from '@openinfo/contracts'

export const SENSE_LANE_SOURCES: readonly PhysicalSenseSource[] = ['mic', 'system-audio', 'screen']

const DISPOSITIONS: readonly SenseLaneDisposition[] = ['stopped', 'waiting', 'queued', 'processed', 'delta-skipped', 'blank', 'failed']
const HEALTH: readonly SenseLaneHealth[] = ['unknown', 'healthy', 'blocked', 'failed']
const REASONS: readonly SenseLaneReason[] = [
  'no-session',
  'awaiting-capture',
  'awaiting-processing',
  'processed',
  'session-ended',
  'delta-skipped',
  'blank',
  'capture-failed',
  'processing-failed',
  'disabled',
  'permission-denied',
  'configuration-blocked',
]
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value)
const owns = (row: Row, key: string): boolean => Object.prototype.hasOwnProperty.call(row, key)
const hasExactKeys = (row: Row, required: readonly string[], optional: readonly string[] = []): boolean => {
  const allowed = new Set([...required, ...optional])
  return required.every((key) => owns(row, key)) && Object.keys(row).every((key) => allowed.has(key))
}
const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const isIsoTime = (value: unknown): value is string =>
  isNonEmptyString(value) && RFC3339.test(value) && Number.isFinite(Date.parse(value))
const member = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && values.includes(value as T)

const capture = (value: unknown): SenseLaneCapture | undefined => {
  if (!isRow(value) || !hasExactKeys(value, ['id', 'capturedAt'])) return undefined
  if (!isNonEmptyString(value['id']) || !isIsoTime(value['capturedAt'])) return undefined
  return { id: value['id'], capturedAt: value['capturedAt'] }
}

const processing = (value: unknown): SenseLaneProcessing | undefined => {
  if (!isRow(value) || !hasExactKeys(value, ['captureId', 'capturedAt', 'completedAt', 'outcome', 'lagMs', 'basis'])) return undefined
  if (!isNonEmptyString(value['captureId']) || !isIsoTime(value['capturedAt']) || !isIsoTime(value['completedAt'])) return undefined
  if (!member(['processed', 'blank', 'failed'] as const, value['outcome'])) return undefined
  if (!Number.isInteger(value['lagMs']) || (value['lagMs'] as number) < 0) return undefined
  if (value['basis'] !== 'capture-to-processing-completion') return undefined
  return {
    captureId: value['captureId'],
    capturedAt: value['capturedAt'],
    completedAt: value['completedAt'],
    outcome: value['outcome'],
    lagMs: value['lagMs'] as number,
    basis: value['basis'],
  }
}

const observation = (value: unknown): ScreenLaneObservation | undefined => {
  if (!isRow(value) || !hasExactKeys(value, ['id', 'occurredAt', 'outcome'])) return undefined
  if (!isNonEmptyString(value['id']) || !isIsoTime(value['occurredAt'])) return undefined
  if (!member(['delta-skipped', 'grab-failed', 'permission-denied'] as const, value['outcome'])) return undefined
  return { id: value['id'], occurredAt: value['occurredAt'], outcome: value['outcome'] }
}

/**
 * Strict runtime boundary shared by initial query hydration and payload-fed updates. Unknown keys are
 * rejected, every nested object is rebuilt, and only the closed metadata contract crosses into the HUD.
 */
export const sanitizeSenseLaneSnapshot = (value: unknown): SenseLaneSnapshot | undefined => {
  if (!isRow(value) || !member(SENSE_LANE_SOURCES, value['source'])) return undefined
  const source = value['source']
  const required = ['workspaceId', 'source', 'disposition', 'health', 'reason', 'updatedAt']
  const optional = ['sessionId', 'latestCapture', 'latestProcessing', ...(source === 'screen' ? ['latestObservation'] : [])]
  if (!hasExactKeys(value, required, optional)) return undefined
  if (!isNonEmptyString(value['workspaceId']) || !member(DISPOSITIONS, value['disposition'])) return undefined
  if (!member(HEALTH, value['health']) || !member(REASONS, value['reason']) || !isIsoTime(value['updatedAt'])) return undefined

  let sessionId: string | undefined
  if (owns(value, 'sessionId')) {
    const candidate = value['sessionId']
    if (!isNonEmptyString(candidate)) return undefined
    sessionId = candidate
  }

  const latestCapture = owns(value, 'latestCapture') ? capture(value['latestCapture']) : undefined
  if (owns(value, 'latestCapture') && latestCapture === undefined) return undefined
  const latestProcessing = owns(value, 'latestProcessing') ? processing(value['latestProcessing']) : undefined
  if (owns(value, 'latestProcessing') && latestProcessing === undefined) return undefined

  const common = {
    workspaceId: value['workspaceId'],
    ...(sessionId !== undefined ? { sessionId } : {}),
    disposition: value['disposition'],
    health: value['health'],
    reason: value['reason'],
    updatedAt: value['updatedAt'],
    ...(latestCapture !== undefined ? { latestCapture } : {}),
    ...(latestProcessing !== undefined ? { latestProcessing } : {}),
  }
  if (source === 'screen') {
    const latestObservation = owns(value, 'latestObservation') ? observation(value['latestObservation']) : undefined
    if (owns(value, 'latestObservation') && latestObservation === undefined) return undefined
    return { ...common, source, ...(latestObservation !== undefined ? { latestObservation } : {}) }
  }
  return { ...common, source }
}
