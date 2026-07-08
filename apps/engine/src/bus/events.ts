import type { CaptureChunk, Distillate, Draft, Entity, Fabric, Flag, Moment, OcrResult, QueueStatus, Session, Surface } from '@openinfo/contracts'

export interface EngineEvents {
  'capture.received': CaptureChunk
  'flag.changed': Flag
  'queue.updated': QueueStatus
  'distillate.updated': Distillate
  // The screen-OCR processor's raw result (P4B). ENGINE-INTERNAL only — deliberately NOT mirrored to
  // the WS Events contract: the standard WS feed already carries this frame's understanding as the
  // distillate.updated it also publishes, and the richer OcrResult (with region blocks) is retrieved via
  // GET /screen/results. A future screen-aware HUD surface can subscribe here and gain a WS broadcast then.
  'ocr.completed': OcrResult
  'moment.created': Moment
  'entity.updated': Entity
  'session.started': Session
  'session.ended': Session
  'session.switched': Session
  'session.rerouted': Session
  'draft.created': Draft
  'fabric.changed': Fabric
  'surface.updated': Surface
}
