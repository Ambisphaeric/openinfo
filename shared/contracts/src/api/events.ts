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
  // A fast field's latest value changed (#61) — published immediately when a fan-out result lands,
  // mirroring transcript.updated; the value is ALSO persisted (FieldValue), unlike the ephemeral feed.
  'field.updated': 'FieldValue',
  'draft.created': 'Draft',
  'fabric.changed': 'Fabric',
  'surface.updated': 'Surface',
  'ledger.updated': 'Commitment',
  'drift.step': 'DriftChainStep',
  'queue.updated': 'QueueStatus',
  'flag.changed': 'Flag',
} as const
export type EventName = keyof typeof Events
