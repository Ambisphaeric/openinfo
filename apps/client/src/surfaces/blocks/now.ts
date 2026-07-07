import { h } from '../block-renderer/vnode.js'
import type { BlockRenderer } from '../block-renderer/registry.js'

/**
 * The `now` block — the context line + live topic + heartbeat (design/renderings/hud-v2.html: "the
 * only place the context is named. No mode chips, no engine labels — one dot is the heartbeat"). It
 * takes no query; the HUD controller derives its data from the live session. Returns the `.hudtop`
 * and `.nowline` as direct children of the panel (a fragment), matching the mockup's structure.
 */
export const renderNow: BlockRenderer = ({ now }) => {
  const hudtop = h(
    'div',
    { class: 'hudtop' },
    h(
      'span',
      { class: 'ctx' },
      now.workspace ? h('span', { class: 'ws' }, `${now.workspace} /`) : null,
      now.workspace ? ` ${now.title ?? 'idle'}` : now.title ?? 'idle',
    ),
    now.elapsed ? h('span', { class: 'el' }, now.elapsed) : null,
    h('span', { class: 'st' }, h('span', { class: now.live ? 'livedot' : 'livedot off' })),
  )
  if (!now.topic) return [hudtop]
  return [hudtop, h('div', { class: 'nowline' }, 'Now: ', h('b', {}, now.topic))]
}
