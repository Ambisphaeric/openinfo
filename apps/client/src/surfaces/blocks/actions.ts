import type { Action } from '@openinfo/contracts'
import { h, type VNode } from '../block-renderer/vnode.js'

/**
 * Render a block's action affordances as the HUD's `.mini` buttons. Each button carries the verb and
 * action id as data-attributes so the (imperative) mount layer can wire them — the pure renderer never
 * touches the DOM or the clipboard. The `copy` verb also carries the ready-to-copy text as `data-copy`
 * (the app prepares; verbs never send/commit outward — Action's own contract note). `copy` is the one
 * live verb this slice wires; the rest render visible-but-inert (see PHASE2-NOTES).
 */
export const actionButtons = (actions: readonly Action[], copyText: string): VNode[] =>
  actions.map((action) =>
    h(
      'button',
      {
        class: action.verb === 'copy' ? 'mini' : 'mini ghost',
        'data-verb': action.verb,
        'data-action': action.id,
        ...(action.verb === 'copy' ? { 'data-copy': copyText } : {}),
      },
      action.label,
    ),
  )
