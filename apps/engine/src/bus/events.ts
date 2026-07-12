import type { CaptureChunk, ChatDelta, Distillate, Draft, Entity, Fabric, FieldValue, Flag, GuardHold, Moment, OcrResult, QueueStatus, Session, SessionAnnotation, Surface, TranscriptUpdate } from '@openinfo/contracts'

export interface EngineEvents {
  'capture.received': CaptureChunk
  'flag.changed': Flag
  'queue.updated': QueueStatus
  'distillate.updated': Distillate
  // Ephemeral live-transcript fast-path (#58): published right after the transcribe drain stage
  // succeeds, broadcast to WS clients, and NEVER persisted. See TranscriptUpdate in contracts.
  'transcript.updated': TranscriptUpdate
  // Ephemeral streaming chat-answer fast-path (the Ask face): published per model-emitted chunk during a
  // POST /chat turn, broadcast to WS clients, NEVER persisted — the ChatReply (and the persisted thread)
  // is the authoritative record. Keyed by the request's client-minted turnId; terminal frame is done:true.
  'chat.delta': ChatDelta
  // The screen-OCR processor's raw result (P4B). ENGINE-INTERNAL only — deliberately NOT mirrored to
  // the WS Events contract: the standard WS feed already carries this frame's understanding as the
  // distillate.updated it also publishes, and the richer OcrResult (with region blocks) is retrieved via
  // GET /screen/results. A future screen-aware HUD surface can subscribe here and gain a WS broadcast then.
  'ocr.completed': OcrResult
  'moment.created': Moment
  'entity.updated': Entity
  // Fast-field fan-out (#61): a field's latest value landed. Published immediately (mirrors
  // transcript.updated) AND persisted as a FieldValue — the ephemeral-then-durable substrate.
  'field.updated': FieldValue
  // Judge-tier orientation pass (#131): the session's nature/direction/topics were (re)classified. Published
  // when a SessionAnnotation lands (annotate-and-correct) AND persisted — the trigger source #134 subscribes to.
  'orientation.updated': SessionAnnotation
  'session.started': Session
  'session.ended': Session
  'session.switched': Session
  'session.rerouted': Session
  'draft.created': Draft
  'fabric.changed': Fabric
  'surface.updated': Surface
  // The egress guard (#63) suspended a hop, or a held hop was released/denied — surfaces refresh their
  // held indicator + release/deny affordance. Payload carries span descriptors, never the raw value.
  'guard.hold.updated': GuardHold
}
