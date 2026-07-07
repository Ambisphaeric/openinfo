/**
 * A tiny virtual-node tree — the block renderer's output. Kept as plain data (no DOM dependency) so
 * the renderer is a PURE function `document + data → VNode`, unit-testable in node without jsdom, and
 * the same tree serializes to HTML for the browser shell to mount. This mirrors the engine's
 * pure-function/imperative-shell split: rendering is pure, mounting is the shell (mount.ts).
 */
export type VNode = string | VElement

export interface VElement {
  tag: string
  attrs: Record<string, string | number | boolean | undefined>
  children: VNode[]
}

type Child = VNode | null | undefined | false | Child[]

const flatten = (children: Child[]): VNode[] => {
  const out: VNode[] = []
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    if (Array.isArray(child)) out.push(...flatten(child))
    else out.push(child)
  }
  return out
}

export const h = (
  tag: string,
  attrs: VElement['attrs'] = {},
  ...children: Child[]
): VElement => ({ tag, attrs, children: flatten(children) })

const escapeText = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const escapeAttr = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/** Serialize a VNode to HTML. Attribute/text values are escaped; only div/span/button are emitted. */
export const renderToHtml = (node: VNode): string => {
  if (typeof node === 'string') return escapeText(node)
  const attrs = Object.entries(node.attrs)
    .filter(([, value]) => value !== undefined && value !== false)
    .map(([name, value]) => (value === true ? ` ${name}` : ` ${name}="${escapeAttr(String(value))}"`))
    .join('')
  return `<${node.tag}${attrs}>${node.children.map(renderToHtml).join('')}</${node.tag}>`
}
