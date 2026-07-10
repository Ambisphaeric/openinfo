/** WS event names and which schema their payload validates against. Data, not code. */
export const Events = {
  'session.started': 'Session',
  'session.ended': 'Session',
  'session.switched': 'Session',
  'session.rerouted': 'Session',
  'moment.created': 'Moment',
  'distillate.updated': 'Distillate',
  // Ephemeral live-transcript fast-path (#58) — payload is a TranscriptUpdate, NOT persisted anywhere.
  'transcript.updated': 'TranscriptUpdate',
  'entity.updated': 'Entity',
  'draft.created': 'Draft',
  'fabric.changed': 'Fabric',
  'surface.updated': 'Surface',
  'ledger.updated': 'Commitment',
  'drift.step': 'DriftChainStep',
  'queue.updated': 'QueueStatus',
  'flag.changed': 'Flag',
} as const
export type EventName = keyof typeof Events
