import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountSurface, renderInto, wireActions, type MountTarget } from '../block-renderer/index.js'
import { clipboardCopy } from './dev-entry.js'

/**
 * Driven coverage for the honest copy action (#43): the copy click must survive a live re-render and
 * carry the exact `data-copy` text to the injected CopyFn, and the ACTUAL outcome of the copy — a
 * working clipboard vs. an unavailable one with a failing fallback — must paint visible success/failure
 * feedback onto the clicked button, never a silent no-op. These tests wire the real `clipboardCopy`
 * through the real `wireActions`, so the whole seam is exercised, not just the markup.
 */

type CopyNav = Parameters<typeof clipboardCopy>[0]
type CopyDoc = Parameters<typeof clipboardCopy>[1]

/** A container that captures the single delegated listener and lets a test dispatch a click at it. */
const makeStage = (): { target: MountTarget; clickButton: (button: ActionButton) => void } => {
  let handler: ((event: { target: { closest(sel: string): ActionButton | null } | null }) => void) | undefined
  const target = {
    innerHTML: '',
    addEventListener: (_type: 'click', h: typeof handler) => {
      handler = h
    },
  }
  return {
    target: target as unknown as MountTarget,
    clickButton: (button) => handler?.({ target: { closest: () => button } }),
  }
}

interface ActionButton {
  textContent: string
  className: string
  getAttribute(name: string): string | null
}
const makeButton = (attrs: Record<string, string>, label = 'Copy', className = 'mini'): ActionButton => ({
  textContent: label,
  className,
  getAttribute: (name) => attrs[name] ?? null,
})

/** A throwaway-textarea document double for the execCommand fallback path. */
const fakeDoc = (opts: { execOk: boolean }): CopyDoc & { created: Array<{ value: string }> } => {
  const created: Array<{ value: string }> = []
  const doc = {
    execCommand: (_command: string) => opts.execOk,
    createElement: (_tag: string) => {
      const el = { value: '', select() {}, remove() {}, appendChild() {} }
      created.push(el)
      return el
    },
    body: { appendChild(_child: unknown) {} },
    created,
  }
  return doc as unknown as CopyDoc & { created: Array<{ value: string }> }
}

/** Drain the microtask queue so the awaited copy outcome and its feedback have settled. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

test('the copy verb is delegated even after a live re-render, carrying the exact data-copy text', () => {
  const received: string[] = []
  const { target, clickButton } = makeStage()
  mountSurface(target, 'first render', { copy: (text) => void received.push(text) })

  // A live update replaces innerHTML; the delegated listener lives on the container and must survive it.
  renderInto(target, 'a live update')
  assert.equal(target.innerHTML, 'a live update')

  clickButton(makeButton({ 'data-verb': 'copy', 'data-copy': 'Dana — Referenced 4×' }))
  assert.deepEqual(received, ['Dana — Referenced 4×'])

  // a non-copy verb stays inert — no write path this slice
  clickButton(makeButton({ 'data-verb': 'open' }))
  assert.deepEqual(received, ['Dana — Referenced 4×'])
})

test('a working clipboard paints visible success feedback on the clicked button', async () => {
  const { target, clickButton } = makeStage()
  let written: string | undefined
  const nav = { clipboard: { writeText: async (t: string) => void (written = t) } }
  wireActions(target, { copy: clipboardCopy(nav as unknown as CopyNav, undefined) })

  const button = makeButton({ 'data-verb': 'copy', 'data-copy': 'SOC 2 report — file:///soc2.pdf' })
  clickButton(button)
  await flush()

  assert.equal(written, 'SOC 2 report — file:///soc2.pdf') // the exact text reached the clipboard
  assert.equal(button.textContent, 'Copied') // driven by the resolved write, not fire-and-forget
  assert.match(button.className, /\bcopied\b/)
})

test('an unavailable clipboard + failing fallback paints visible failure feedback — never a silent no-op', async () => {
  const { target, clickButton } = makeStage()
  // no navigator.clipboard AND execCommand returns false: every copy path fails
  wireActions(target, { copy: clipboardCopy(undefined, fakeDoc({ execOk: false })) })

  const button = makeButton({ 'data-verb': 'copy', 'data-copy': 'x' })
  clickButton(button)
  await flush()

  assert.equal(button.textContent, 'Copy failed')
  assert.match(button.className, /\bcopyfail\b/)
})

test('clipboardCopy resolves via the async Clipboard API and forwards the exact text', async () => {
  let written: string | undefined
  const nav = { clipboard: { writeText: async (t: string) => void (written = t) } }
  await clipboardCopy(nav as unknown as CopyNav, undefined)('exact payload')
  assert.equal(written, 'exact payload')
})

test('clipboardCopy falls back to the execCommand textarea when the async API is unavailable', async () => {
  const doc = fakeDoc({ execOk: true })
  await clipboardCopy(undefined, doc)('payload text') // resolves via the fallback
  assert.equal(doc.created[0]?.value, 'payload text') // the throwaway textarea carried the text
})

test('clipboardCopy falls back when the async API rejects (denied / insecure context)', async () => {
  const nav = { clipboard: { writeText: async () => Promise.reject(new Error('denied')) } }
  const doc = fakeDoc({ execOk: true })
  await clipboardCopy(nav as unknown as CopyNav, doc)('rescued') // rejection → fallback → resolves
  assert.equal(doc.created[0]?.value, 'rescued')
})

test('clipboardCopy rejects when neither the async API nor the fallback can copy', async () => {
  await assert.rejects(clipboardCopy(undefined, fakeDoc({ execOk: false }))('x'))
})
