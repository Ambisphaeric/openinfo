import type { Action, AttributionPattern } from '@openinfo/contracts'
import { h, type VNode } from '../block-renderer/vnode.js'

/**
 * The per-row payload a block hands its wired action verbs. A verb only renders LIVE (a solid `.mini`
 * button the mount layer will act on) when the block supplies the data that verb needs to write; absent
 * that data it renders visible-but-inert (`.mini ghost`), so a button is never falsely live. `copy`
 * always carries its ready-to-copy text; `markDone` addresses a to-do for PUT /todos/:sessionId;
 * `accept` carries the teach candidate to apply via PUT /hints/:workspaceId (#15).
 */
export interface ActionPayload {
  copy: string
  markDone?: { sessionId: string; todoId: string }
  accept?: { workspaceId: string; pattern: AttributionPattern }
}

/**
 * Render a block's action affordances as the HUD's `.mini` buttons. Each button carries the verb and
 * action id as data-attributes so the (imperative) mount layer can wire them — the pure renderer never
 * touches the DOM or the network. A verb the mount layer WIRES this slice (copy/mark-done/accept) renders
 * as a live `.mini` button carrying its write payload, but ONLY when this block supplied that payload;
 * every other verb — and a wired verb with no payload — renders visible-but-inert (`.mini ghost`), so a
 * button is live iff it can actually act (the app prepares; verbs never send/commit outward — Action's
 * own contract note). `copyText` is accepted positionally (every block has it); richer write payloads
 * ride in the optional `wired` arg (only the todos/teach blocks supply them).
 */
export const actionButtons = (
  actions: readonly Action[],
  copyText: string,
  wired: { markDone?: ActionPayload['markDone']; accept?: ActionPayload['accept'] } = {},
): VNode[] =>
  actions.map((action) => {
    const data: Record<string, string> = {}
    let live = false
    if (action.verb === 'copy') {
      data['data-copy'] = copyText
      live = true
    } else if (action.verb === 'mark-done' && wired.markDone) {
      data['data-session'] = wired.markDone.sessionId
      data['data-todo'] = wired.markDone.todoId
      live = true
    } else if (action.verb === 'accept' && wired.accept) {
      data['data-workspace'] = wired.accept.workspaceId
      data['data-pattern'] = JSON.stringify(wired.accept.pattern)
      live = true
    }
    return h(
      'button',
      {
        class: live ? 'mini' : 'mini ghost',
        'data-verb': action.verb,
        'data-action': action.id,
        ...data,
      },
      action.label,
    )
  })
