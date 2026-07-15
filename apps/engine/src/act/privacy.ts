import type { ContentClass, Distillate, Moment, TodoItem } from '@openinfo/contracts'

/**
 * The Act prompts are composites. Preserve the strongest origin among the records actually interpolated:
 * OCR/VLM mirror distillates, screen moments (or moments parented by such a mirror), and todos produced by
 * a screen-class task pass all make the composite `screen`. That class dominates transcript/typed material
 * and therefore keeps the invoke off hosted/public endpoints.
 */
export const effectiveActContentClass = (input: {
  distillates: readonly Distillate[]
  moments: readonly Moment[]
  todo?: readonly TodoItem[] | undefined
}): ContentClass => {
  const screenDistillates = new Set(
    input.distillates
      .filter((d) => d.provenance.slot === 'ocr' || d.provenance.slot === 'vlm')
      .map((d) => d.id),
  )
  const screenMoments = new Set(
    input.moments
      .filter((m) => m.source === 'screen' || (m.provenance?.distillateId !== undefined && screenDistillates.has(m.provenance.distillateId)))
      .map((m) => m.id),
  )
  if (screenDistillates.size > 0 || screenMoments.size > 0) return 'screen'
  if (
    (input.todo ?? []).some(
      (item) =>
        item.provenance?.contentClass === 'screen' ||
        (item.provenance?.distillateId !== undefined && screenDistillates.has(item.provenance.distillateId)) ||
        (item.provenance?.momentId !== undefined && screenMoments.has(item.provenance.momentId)),
    )
  ) return 'screen'
  return 'transcript'
}
