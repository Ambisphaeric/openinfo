import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Block } from '@openinfo/contracts'
import { renderToHtml, type NowContext } from '../block-renderer/index.js'
import { defaultBlockRegistry } from './index.js'
import { renderInput } from './input.js'

const now: NowContext = { live: false }
const render = (block: Block): string => {
  const node = renderInput({ block, now })
  assert.ok(node && !Array.isArray(node))
  return renderToHtml(node)
}

test('input renderer stamps target/submit/mode as data-attributes and emits the entry regions', () => {
  const html = render({
    block: 'input',
    input: { target: 'chat', submit: '/chat', mode: 'both', placeholder: 'Ask…', submitLabel: 'Send', accept: '.pdf,.txt' },
  })
  assert.match(html, /class="input-block"/)
  assert.match(html, /data-target="chat"/)
  assert.match(html, /data-submit="\/chat"/)
  assert.match(html, /data-mode="both"/)
  assert.match(html, /data-accept="\.pdf,\.txt"/)
  // the wiring's re-inject regions are present and empty
  assert.match(html, /class="in-log"/)
  assert.match(html, /class="in-context"/)
  assert.match(html, /class="in-status"/)
  // both text + file affordances for mode:both, plus a submit carrying the wiring verb
  assert.match(html, /<textarea[^>]*class="in-text"/)
  assert.match(html, /placeholder="Ask…"/)
  assert.match(html, /<input[^>]*class="in-file"[^>]*accept="\.pdf,\.txt"/)
  assert.match(html, /data-verb="input-submit"[^>]*>Send</)
})

test('input renderer honours mode:text (no file drop) and mode:file (no textarea)', () => {
  const textOnly = render({ block: 'input', input: { target: 'entity-map', submit: '/query', mode: 'text' } })
  assert.match(textOnly, /class="in-text"/)
  assert.doesNotMatch(textOnly, /class="in-file"/)

  const fileOnly = render({ block: 'input', input: { target: 'pins', submit: '/pins', mode: 'file' } })
  assert.match(fileOnly, /class="in-file"/)
  assert.doesNotMatch(fileOnly, /class="in-text"/)
})

test('input renderer defaults mode to text and label to Send', () => {
  const html = render({ block: 'input', input: { target: 'chat', submit: '/chat' } })
  assert.match(html, /data-mode="text"/)
  assert.match(html, />Send</)
})

test('input renderer renders an explainable empty when misconfigured (no input config)', () => {
  const html = render({ block: 'input' })
  assert.match(html, /no target\/submit configured/)
})

test('the input block type is registered in the default registry', () => {
  assert.equal(defaultBlockRegistry.input, renderInput)
})
