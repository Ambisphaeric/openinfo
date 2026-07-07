/** WS event names and which schema their payload validates against. Data, not code. */
export const Events = {
  'session.started': 'Session',
  'session.ended': 'Session',
  'session.switched': 'Session',
  'moment.created': 'Moment',
  'distillate.updated': 'Distillate',
  'entity.updated': 'Entity',
  'ledger.updated': 'Commitment',
  'drift.step': 'DriftChainStep',
  'queue.updated': 'QueueStatus',
  'flag.changed': 'Flag',
} as const
export type EventName = keyof typeof Events
