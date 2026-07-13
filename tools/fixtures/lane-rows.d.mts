export interface FixtureLaneCapture {
  id: string
  capturedAt: string
}

export interface FixtureLaneProcessing {
  captureId: string
  capturedAt: string
  completedAt: string
  outcome: 'processed'
  lagMs: number
  basis: 'capture-to-processing-completion'
}

/**
 * The closed metadata shape a fixture lane projects to — structurally the contracts' `SenseLaneSnapshot`
 * for a processed lane. Typed here without importing @openinfo/contracts so this tools/ module stays free
 * of a workspace dependency it does not declare; consumers cast to `SenseLaneSnapshot` at the call site.
 */
export interface FixtureSenseLaneRow {
  workspaceId: string
  sessionId: string
  source: 'mic' | 'system-audio' | 'screen'
  disposition: 'processed'
  health: 'healthy'
  reason: 'processed'
  updatedAt: string
  latestCapture: FixtureLaneCapture
  latestProcessing: FixtureLaneProcessing
}

export function senseLaneRowsFromFixture(fixture: unknown): FixtureSenseLaneRow[]
