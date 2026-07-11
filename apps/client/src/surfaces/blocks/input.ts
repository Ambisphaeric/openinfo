import type { Block } from '@openinfo/contracts'
import { h, type VNode } from '../block-renderer/vnode.js'
import type { BlockRenderer } from '../block-renderer/registry.js'

/**
 * The `input` block (#134) — the text-entry / file-drop PRIMITIVE, rendered as a composable card like any
 * other block. It is a PURE structure: the renderer emits the entry affordances plus empty log/context/
 * status regions and stamps the document's `target`/`submit`/`mode`/`accept` as data-attributes on the
 * container. The imperative wiring (surfaces/hud/input-submit.ts, installed once at mount) reads those
 * attributes, POSTs a submit to the configured route, and paints the answer/attachment/turn-budget — and,
 * crucially, a FAILED submit — into the status region as VISIBLE TEXT (the QA doctrine: never a silent
 * no-op). The log/context regions are re-populated by the controller after each panel re-render (the same
 * compose-after-render discipline the live-transcript strip uses), so a destructive re-render never eats
 * the conversation.
 *
 * `mode` (default `text`) picks the affordances: `text` → the textarea + submit; `file` → the drop zone +
 * file picker + submit; `both` → all three. `accept` filters the file picker. With no `input` config the
 * card renders an explainable empty rather than a broken control (a misconfigured document is honest, not
 * blank).
 */
export const renderInput: BlockRenderer = ({ block }) => {
  const cfg = block.input
  if (!cfg) {
    return h('div', { class: 'input-block' }, h('div', { class: 'in-empty' }, 'input block: no target/submit configured'))
  }
  const mode = cfg.mode ?? 'text'
  const wantsText = mode === 'text' || mode === 'both'
  const wantsFile = mode === 'file' || mode === 'both'
  const label = cfg.submitLabel ?? 'Send'

  const controls: VNode[] = []
  if (wantsText) {
    controls.push(
      h('textarea', {
        class: 'in-text',
        rows: 1,
        placeholder: cfg.placeholder ?? 'Type a message',
        'aria-label': `entry for ${cfg.target}`,
      }),
    )
  }
  if (wantsFile) {
    controls.push(
      h('label', { class: 'in-drop', 'data-drop': true }, 'Attach a file to cite',
        h('input', { class: 'in-file', type: 'file', ...(cfg.accept !== undefined ? { accept: cfg.accept } : {}) }),
      ),
    )
  }
  controls.push(h('button', { class: 'mini in-submit', 'data-verb': 'input-submit', type: 'button' }, label))

  return h(
    'div',
    {
      class: 'input-block',
      'data-target': cfg.target,
      'data-submit': cfg.submit,
      'data-mode': mode,
      ...(cfg.accept !== undefined ? { 'data-accept': cfg.accept } : {}),
    },
    h('div', { class: 'in-log' }),
    h('div', { class: 'in-context' }),
    h('div', { class: 'in-row' }, ...controls),
    h('div', { class: 'in-status' }),
  )
}
