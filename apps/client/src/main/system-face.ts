import { h, renderToHtml, type VNode } from '../surfaces/block-renderer/vnode.js'
import type { EngineDisposition } from './engine-supervisor.js'

/**
 * The System face (S6) — the one in-app surface that answers "which version + build am I actually running,
 * and is my engine the one I think it is?" In-app version surfacing was effectively nonexistent: /health's
 * build-sha rendered nowhere, packaged builds never set it, and a version/build mismatch was silent. This
 * face makes both plain, and — when the shell REFUSES a mismatched engine — carries the blocking banner
 * that explains the refusal and how a dev opts back in.
 *
 * It is a MAIN-PROCESS renderer: the version/build facts (the app's own version + build, the adopted/
 * spawned engine's /health identity, the skew verdict) all live in the shell, not in an engine-served
 * surface document, so the shell builds the page itself and loads it into a plain window as a self-contained
 * data URL. The layout is a pure `model → HTML string` function (reusing the block renderer's tested vnode
 * serializer for escaping) so the whole face is asserted headless — no window, no DOM.
 */

/** The skew half of the model — present only when a version/build mismatch was detected. */
export interface SystemFaceSkew {
  /** the engine was refused (default) vs. adopted-anyway under the dev flag. */
  refused: boolean
  /** the plain-language mismatch explanation (from assessEngineSkew). */
  reason: string
}

/** Everything the System face renders — the app's own identity, the engine's, and any skew. */
export interface SystemFaceModel {
  appVersion: string
  /** the app's build id (git short sha), when this is a stamped/packaged build; absent in a dev run. */
  appBuild?: string
  engineDisposition?: EngineDisposition
  engineVersion?: string
  engineBuild?: string
  engineUrl?: string
  skew?: SystemFaceSkew
}

/** Render "vX · build Y" / "vX" / "unknown", the shared identity line for the app and the engine. */
const identity = (version: string | undefined, build: string | undefined): string => {
  const v = version ? `v${version}` : 'version unknown'
  return build && build.trim() !== '' ? `${v} · build ${build.trim()}` : v
}

/** The engine's disposition + location in words ("adopted at http://…", "spawned (bundled)", "unreachable"). */
const engineWhere = (model: SystemFaceModel): string => {
  switch (model.engineDisposition) {
    case 'adopt':
      return model.engineUrl ? `adopted — ${model.engineUrl}` : 'adopted'
    case 'spawn':
      return 'spawned (bundled)'
    case 'unreachable':
      return 'unreachable'
    default:
      return 'not yet determined'
  }
}

/** A labeled row (label + value) — the face's one repeated element. */
const row = (label: string, value: string): VNode =>
  h('div', { class: 'row' }, h('span', { class: 'label' }, label), h('span', { class: 'value' }, value))

/** The banner block, shown only under skew: a hard red refusal or a softer amber dev-allowed note. */
const banner = (skew: SystemFaceSkew): VNode =>
  h(
    'div',
    { class: skew.refused ? 'banner banner-refused' : 'banner banner-allowed' },
    h('div', { class: 'banner-title' }, skew.refused ? '⚠ Engine mismatch — refused' : '⚠ Engine mismatch — adopted anyway (dev)'),
    h('div', { class: 'banner-reason' }, skew.reason),
    h(
      'div',
      { class: 'banner-hint' },
      skew.refused
        ? 'This client will not drive sessions through a mismatched engine. Restart the matching engine, or set OPENINFO_ALLOW_ENGINE_SKEW=1 to adopt it anyway (dev workflows).'
        : 'OPENINFO_ALLOW_ENGINE_SKEW is set, so the mismatch was adopted rather than refused.',
    ),
  )

/** The face body as a vnode tree — pure, so it serializes identically for the test and the window. */
export const systemFaceBody = (model: SystemFaceModel): VNode =>
  h(
    'div',
    { class: 'face' },
    h('div', { class: 'title' }, 'openinfo — System'),
    ...(model.skew ? [banner(model.skew)] : []),
    h(
      'div',
      { class: 'section' },
      h('div', { class: 'section-title' }, 'This app'),
      row('version', identity(model.appVersion, model.appBuild)),
    ),
    h(
      'div',
      { class: 'section' },
      h('div', { class: 'section-title' }, 'Engine'),
      row('status', engineWhere(model)),
      row('version', model.engineDisposition === 'unreachable' ? '—' : identity(model.engineVersion, model.engineBuild)),
    ),
  )

/** The inline stylesheet — self-contained (the window loads a data: URL; no external assets can load). */
const SYSTEM_FACE_STYLES = `
  :root { color-scheme: light dark; }
  body { margin: 0; font: 13px/1.5 -apple-system, system-ui, sans-serif; background: #1c1c1e; color: #f2f2f7; }
  .face { padding: 20px 22px; max-width: 640px; }
  .title { font-size: 15px; font-weight: 600; margin-bottom: 16px; opacity: 0.85; }
  .section { margin-bottom: 16px; }
  .section-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.5; margin-bottom: 6px; }
  .row { display: flex; gap: 12px; padding: 3px 0; }
  .label { min-width: 72px; opacity: 0.55; }
  .value { font-variant-numeric: tabular-nums; word-break: break-all; }
  .banner { border-radius: 8px; padding: 12px 14px; margin-bottom: 18px; }
  .banner-refused { background: #3a1416; border: 1px solid #a3252b; }
  .banner-allowed { background: #3a3014; border: 1px solid #a3852b; }
  .banner-title { font-weight: 600; margin-bottom: 5px; }
  .banner-reason { margin-bottom: 6px; }
  .banner-hint { opacity: 0.7; font-size: 12px; }
`

/** The complete self-contained HTML document — what the shell loads into the System window as a data URL. */
export const systemFaceHtml = (model: SystemFaceModel): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>openinfo — System</title>` +
  `<style>${SYSTEM_FACE_STYLES}</style></head><body>${renderToHtml(systemFaceBody(model))}</body></html>`

/** The `data:` URL the shell hands to `window.loadURL` — encoded so the whole page rides the URL. */
export const systemFaceDataUrl = (model: SystemFaceModel): string =>
  `data:text/html;charset=utf-8,${encodeURIComponent(systemFaceHtml(model))}`
