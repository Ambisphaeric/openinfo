/** WS event names and which schema their payload validates against. Data, not code. */
export const Events = {
  // Public receipt only: raw CaptureChunk.data remains on the engine-internal bus for OCR/STT/drain.
  'capture.received': 'CaptureReceipt',
  'session.started': 'Session',
  'session.ended': 'Session',
  'session.switched': 'Session',
  'session.rerouted': 'Session',
  'moment.created': 'Moment',
  'distillate.updated': 'Distillate',
  // Ephemeral live-transcript fast-path (#58) — payload is a TranscriptUpdate, NOT persisted anywhere.
  'transcript.updated': 'TranscriptUpdate',
  // Ephemeral streaming chat-answer fast-path (the Ask face) — payload is a ChatDelta, NOT persisted;
  // the POST /chat ChatReply (and the persisted thread) is the authoritative record (the #58 idiom).
  'chat.delta': 'ChatDelta',
  'entity.updated': 'Entity',
  // A fast field's latest value changed (#61) — published immediately when a fan-out result lands,
  // mirroring transcript.updated; the value is ALSO persisted (FieldValue), unlike the ephemeral feed.
  'field.updated': 'FieldValue',
  // The judge-tier orientation pass (#131) re-classified the session's nature/direction/topics — the
  // trigger source a contextual sidebar (#134) subscribes to. Payload is the engine-stamped SessionAnnotation.
  'orientation.updated': 'SessionAnnotation',
  'draft.created': 'Draft',
  'fabric.changed': 'Fabric',
  'surface.updated': 'Surface',
  'ledger.updated': 'Commitment',
  'drift.step': 'DriftChainStep',
  'queue.updated': 'QueueStatus',
  'flag.changed': 'Flag',
  // The egress guard (#63) suspended a hop, or a held hop was released/denied — the surface refreshes its
  // held-indicator + release/deny affordance. Payload is the GuardHold (verdict carries span-level detail,
  // never the raw value).
  'guard.hold.updated': 'GuardHold',
} as const
export type EventName = keyof typeof Events
