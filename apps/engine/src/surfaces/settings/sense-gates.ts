import type { Endpoint, Fabric, Flag, QueueFailure } from '@openinfo/contracts'
import type { EndpointHealth } from '../../fabric/health.js'

/**
 * The per-sense GATE CHAIN (issue #7) — a pure, ordered evaluation of the engine-side gates each sense
 * must clear for its capture to actually become something (a transcript for the audio senses, an OCR
 * read for screen). A sense can be silently dead because a processing flag is off, a slot has no
 * endpoint, or the configured endpoint is failing — with the only observable being "no transcript".
 * This composes those scattered checks into ONE named verdict per sense: the FIRST closed gate is the
 * blocker, with a one-step fix hint, so no sense ever reads as generically "off" when a specific gate
 * is the cause.
 *
 * Scope: this is the ENGINE half of the chain — the gates the engine can honestly answer from the state
 * it already holds (flags, the live fabric's slots, the queue's last classified drain failure, and —
 * when a caller affords the probe — live endpoint health). The CLIENT-side gates that PRECEDE these
 * (sense toggled off, OS/TCC permission, engine reachable) live in the client's capture-status readout
 * and chain in FRONT of this verdict; the tray shows the first blocker across the whole chain.
 *
 * Pure and I/O-free: health is an INPUT (EndpointHealth from fabric/health.ts, or the queue's
 * QueueFailure), never probed here — so every gate combination is asserted headless. Reuses the existing
 * signals (GET /flags, GET /fabric slots, GET /queue lastFailure, checkEndpoint/EndpointHealth) rather
 * than re-implementing any health logic.
 */

/** The three capture senses, sharing the client capture-status readout's sense ids for a 1:1 mapping. */
export type CaptureSense = 'mic' | 'sys-audio' | 'screen'

/** One gate in a sense's chain: an ordered pass/fail check with a one-step fix hint when it is closed. */
export interface SenseGate {
  /** stable id (the flag key / slot name / 'stt-health') — for tests + client mapping */
  id: string
  /** human label for the readout ("Distill enabled", "Hearing (stt) endpoint") */
  label: string
  /** is this gate open? */
  pass: boolean
  /** the single "what to do" step when this gate is the blocker — one-click/one-step */
  fix?: string
  /** honest extra context (e.g. the classified failure's own hint) */
  detail?: string
}

/** A sense's full ordered chain plus the FIRST closed gate (undefined ⇒ every engine-side gate is open). */
export interface SenseGateChain {
  sense: CaptureSense
  /** human sense name ("Microphone", "System audio", "Screen") */
  label: string
  /** the ordered gates — evaluated front to back; the first !pass is the blocker */
  gates: SenseGate[]
  /** the first closed gate, or undefined when the sense is clear engine-side */
  blocking?: SenseGate
}

export interface SenseGateInput {
  /** every flag (GET /flags shape) — the processing-flag gates read from here */
  flags: Flag[]
  /** the live fabric (GET /fabric) — slot occupancy gates read its stt/ocr slots */
  fabric: Fabric
  /**
   * The queue's last classified drain failure (GET /queue lastFailure) — the honest "the endpoint is
   * failing" signal, reused rather than re-probed. A failure whose endpoint name matches a slot's
   * endpoint closes that slot's health gate, carrying the failure's own hint.
   */
  lastFailure?: QueueFailure
  /**
   * OPTIONAL live endpoint health (checkEndpoint → EndpointHealth) keyed by endpoint name — a caller that
   * can afford the probe (the GET /senses route) feeds it so the health gate reflects a LIVE check; the
   * pure Status-section render omits it and relies on lastFailure alone (no new probe in the render path).
   */
  health?: Record<string, EndpointHealth>
}

/** Is a flag on in the GET /flags list? Unknown/absent reads OFF (matches isFlagEnabled). */
const flagOn = (flags: Flag[], key: string): boolean => flags.some((f) => f.key === key && f.default === true)

/** Human sense names, in the client's display order. */
const SENSE_LABEL: Record<CaptureSense, string> = { mic: 'Microphone', 'sys-audio': 'System audio', screen: 'Screen' }

/**
 * The health verdict for a slot's endpoints: undefined (no evidence of trouble) or a failing gate detail.
 * Reuses (1) live EndpointHealth when the caller probed, and (2) the queue's classified lastFailure whose
 * endpoint name matches one of the slot's endpoints — never re-implementing a health check.
 */
const slotHealthFailure = (
  endpoints: readonly Endpoint[],
  input: SenseGateInput,
): { fix: string; detail: string } | undefined => {
  const names = new Set(endpoints.map((e) => e.name))
  // A live probe result (checkEndpoint) takes precedence — it is the freshest signal.
  for (const name of names) {
    const h = input.health?.[name]
    if (h && !h.ok) return { fix: `Check the endpoint in Settings → Endpoints — ${h.error ?? 'it is not answering'}`, detail: h.error ?? 'endpoint unhealthy' }
  }
  // Else the drain's last classified failure, if it landed on one of this slot's endpoints.
  const f = input.lastFailure
  if (f && names.has(f.endpoint)) return { fix: f.hint, detail: `${f.class} on ${f.endpoint}` }
  return undefined
}

/**
 * The audio-transcript chain (mic, system-audio): a captured audio segment becomes a transcript only if
 * distillation is on, transcription is on, an stt endpoint is configured, and that endpoint is healthy —
 * in that order. Any earlier gate short-circuits the observable ("no transcript").
 */
const audioGates = (sense: CaptureSense, input: SenseGateInput): SenseGate[] => {
  const stt = input.fabric.slots.stt
  const health = stt.length > 0 ? slotHealthFailure(stt, input) : undefined
  return [
    {
      id: 'distill.enabled',
      label: 'Distill enabled',
      pass: flagOn(input.flags, 'distill.enabled'),
      fix: 'Enable “Distill what is captured” in Settings → Features (distill.enabled).',
      detail: 'Without it, captured audio is spooled and dropped from processing with no transcript.',
    },
    {
      id: 'distill.transcribe',
      label: 'Transcribe audio',
      pass: flagOn(input.flags, 'distill.transcribe'),
      fix: 'Enable “Transcribe audio (speech → text)” in Settings → Features (distill.transcribe).',
      detail: 'Audio is captured but never turned into text until this is on.',
    },
    {
      id: 'stt',
      label: 'Hearing (stt) endpoint',
      pass: stt.length > 0,
      fix: 'Add an stt endpoint in Settings → Endpoints.',
      detail: 'The stt slot is empty — there is no model to transcribe with.',
    },
    {
      id: 'stt-health',
      label: 'stt endpoint healthy',
      pass: health === undefined,
      ...(health ? { fix: health.fix, detail: health.detail } : {}),
    },
  ]
}

/**
 * The screen-OCR chain (screen): a captured frame is understood by OCR — INDEPENDENTLY of distill (a
 * frame is read by the ocr slot, not the transcript distiller) — only if screen.ocr is on, an ocr
 * endpoint is configured, and it is healthy.
 */
const screenGates = (input: SenseGateInput): SenseGate[] => {
  const ocr = input.fabric.slots.ocr
  const health = ocr.length > 0 ? slotHealthFailure(ocr, input) : undefined
  return [
    {
      id: 'screen.ocr',
      label: 'Screen OCR enabled',
      pass: flagOn(input.flags, 'screen.ocr'),
      fix: 'Enable screen OCR in Settings → Features (screen.ocr).',
      detail: 'Without it, captured frames are not read.',
    },
    {
      id: 'ocr',
      label: 'Reading (ocr) endpoint',
      pass: ocr.length > 0,
      fix: 'Add an ocr endpoint in Settings → Endpoints.',
      detail: 'The ocr slot is empty — there is no model to read frames with.',
    },
    {
      id: 'ocr-health',
      label: 'ocr endpoint healthy',
      pass: health === undefined,
      ...(health ? { fix: health.fix, detail: health.detail } : {}),
    },
  ]
}

/** Assemble one sense's chain: its ordered gates + the first closed one as the named blocker. */
const chainFor = (sense: CaptureSense, gates: SenseGate[]): SenseGateChain => {
  const blocking = gates.find((g) => !g.pass)
  return { sense, label: SENSE_LABEL[sense], gates, ...(blocking ? { blocking } : {}) }
}

/**
 * Evaluate the engine-side gate chain for every sense (mic, system-audio, screen), in display order.
 * Pure — the caller supplies flags, fabric, the queue's last failure, and (optionally) live health.
 */
export const evaluateSenseGates = (input: SenseGateInput): SenseGateChain[] => [
  chainFor('mic', audioGates('mic', input)),
  chainFor('sys-audio', audioGates('sys-audio', input)),
  chainFor('screen', screenGates(input)),
]
