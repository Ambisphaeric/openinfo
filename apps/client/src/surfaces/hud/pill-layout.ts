import type { Surface } from '@openinfo/contracts'
import { h, renderSurface, type BlockRegistry, type SurfaceRenderInput, type VElement, type VNode } from '../block-renderer/index.js'
import type { PillState } from './pill.js'

/**
 * The PILL layout (#the-pill) — the compact header RECTANGLE + a docked panel that switches between the
 * Listen and Ask faces. Signature-compatible with `renderSurface` (built as a CLOSURE over the pill's
 * view-state + resolved face surfaces), so the Hud controller renders and live-updates it exactly like any
 * other surface — dev-entry selects it by surface id, exactly as it selects the note-taker's three-zone
 * frame. It FORKS NOTHING: each face's body is rendered through the SAME generic `renderSurface`.
 *
 *  - LISTEN face = the pill surface's OWN glance stack (this input) rendered through `renderSurface` — the
 *    distilled glance blocks. The #58 live-transcript strip is composed by the Hud controller onto the
 *    frame's last child (as for every surface); the pill CSS parks it under the panel and hides it on the
 *    Ask face. The pill IS the bundle's `hud` glance face, so it owns this content.
 *  - ASK face = the surface the bundle's `chat` face RESOLVED to (GET /bundles → chat surfaceRef → GET
 *    /layouts/surfaces/:ref), rendered through the SAME `renderSurface` — its `input` block is the shipped
 *    chat organ (the InputSession wires it over the container in dev-entry). A different bundle's chat face
 *    ⇒ a different Ask panel. Unresolved / absent ⇒ an HONEST visible state (never a blank panel).
 *
 * HONESTY (interaction lint): every header button is WIRED (a verb the mount layer dispatches) or DISABLED
 * with disclosure — the Ask affordance is disabled until its bundle face resolves.
 */

/** The verbs the pill header carries — dispatched client-local by the mount layer (see mount.ts). */
export const PILL_FACE_VERB = 'pill-face'
export const PILL_TOGGLE_VERB = 'pill-toggle'
export const PILL_SETTINGS_VERB = 'pill-settings'

/** The Ask-face source resolved from the bundle — the chat surface, or an honest reason it is unavailable. */
export interface PillFaceSources {
  /** the surface the bundle's chat face resolved to; null while resolving or when the bundle has no chat face. */
  chat: Surface | null
  /** true while GET /bundles / the chat surface fetch is still in flight (an honest "resolving…" state). */
  resolving: boolean
  /** the human reason the chat face is unavailable (a missing chat face, or a failed fetch) — painted as text. */
  chatError?: string
}

/**
 * The TRUE current reason the disabled Ask affordance is disabled — never a static lie. While the resolve
 * loop is still working (including between its retries: the engine may simply not have finished spawning),
 * it is honestly "catching up"; once the resolve has TERMINALLY settled (the bundle answered with no chat
 * face) the tooltip states that real reason. The old static title claimed "no chat face yet" even while the
 * only problem was the engine-spawn race — the tooltip lied on every packaged cold boot.
 */
export const askDisabledTitle = (sources: PillFaceSources): string =>
  sources.resolving ? 'Ask — catching up, chat will be ready in a moment' : `Ask — ${sources.chatError ?? 'this app has no chat face'}`

/** The Listen/Ask face toggle button — active-styled for the current face, wired unless Ask is unavailable. */
const faceButton = (label: string, face: 'listen' | 'ask', active: boolean, available: boolean, disabledTitle?: string): VNode => {
  if (face === 'ask' && !available) {
    // HONEST disabled-with-disclosure (the note-taker Record posture): the OS paints it non-interactive and
    // it never receives a click; the title says the TRUE current reason (askDisabledTitle — catching up vs
    // genuinely no chat face). It lights up the instant the chat face resolves (the retry loop keeps trying).
    return h(
      'button',
      { class: 'pill-face-btn', 'data-face': 'ask', disabled: true, title: disabledTitle ?? 'Ask — catching up, chat will be ready in a moment' },
      label,
    )
  }
  return h(
    'button',
    { class: `pill-face-btn${active ? ' active' : ''}`, 'data-verb': PILL_FACE_VERB, 'data-face': face, type: 'button' },
    label,
  )
}

/** The compact header rectangle: brand identity · Listen/Ask mode toggle · Show-Hide · settings-on-hover. */
const pillBar = (state: { face: 'listen' | 'ask'; open: boolean; askAvailable: boolean }, name: string, sources: PillFaceSources): VNode =>
  h(
    'div',
    { class: 'pill-bar' },
    h('div', { class: 'pill-brand' }, h('span', { class: 'pill-dot' }), h('span', { class: 'pill-name' }, name)),
    h(
      'div',
      { class: 'pill-faces' },
      faceButton('Listen', 'listen', state.open && state.face === 'listen', true),
      faceButton('Ask', 'ask', state.open && state.face === 'ask', state.askAvailable, askDisabledTitle(sources)),
    ),
    h(
      'div',
      { class: 'pill-tools' },
      // Show-Hide collapses the docked panel to the bar and back (the panel's own height authority).
      h(
        'button',
        { class: 'pill-toggle', 'data-verb': PILL_TOGGLE_VERB, type: 'button', title: state.open ? 'Hide the panel' : 'Show the panel' },
        state.open ? 'Hide' : 'Show',
      ),
      // Settings-on-hover: a hover-revealed affordance that opens the EXISTING settings path (dev-entry
      // routes it to the shell's open-settings bridge — the same GET /settings the tray opens).
      h('button', { class: 'pill-settings', 'data-verb': PILL_SETTINGS_VERB, type: 'button', title: 'Settings', 'aria-label': 'Settings' }, '⚙'),
    ),
  )

/** The honest Ask panel when its bundle face is unresolved/absent — visible text, never a blank panel. */
const honestAskPanel = (sources: PillFaceSources): VElement =>
  h(
    'div',
    { class: 'hud' },
    h('div', { class: 'pill-face-note' }, sources.resolving ? 'Catching up — chat will be ready in a moment.' : sources.chatError ?? 'This app has no chat face.'),
  )

/**
 * Build the pill renderer as a closure over the pill's view-state (a getter, so the renderer works before
 * the PillController is constructed in onSurfaceLoaded) + the (mutable) resolved face sources. Returns a
 * `renderSurface`-compatible function the Hud controller calls on every (re)render.
 */
export const createPillRenderer =
  (pillState: () => PillState, sources: () => PillFaceSources) =>
  (input: SurfaceRenderInput, registry: BlockRegistry): VElement => {
    const state = pillState()
    const src = sources()
    // Listen body: the pill surface's own hydrated glance stack, through the generic renderer.
    const listenBody = renderSurface(input, registry)
    // Ask body: the resolved chat surface (its `input` block is query-less, so no hydration), through the
    // SAME generic renderer; or the honest unresolved/absent state.
    const askBody = src.chat
      ? renderSurface({ surface: src.chat, now: input.now, results: [], ...(input.clarify !== undefined ? { clarify: input.clarify } : {}) }, registry)
      : honestAskPanel(src)
    // Only the ACTIVE face's body is in the panel — switching is instant client-local view state (the Hud
    // re-render is driven by the controller's onChange, no re-fetch). The live-transcript strip the Hud
    // appends after this frame is parked (and, on the Ask face, hidden) by the pill CSS.
    const body = state.open ? (state.face === 'ask' ? askBody : listenBody) : h('div', { class: 'hud pill-collapsed' })
    return h(
      'div',
      { class: 'pill-app', 'data-face': state.face, 'data-open': state.open ? 'true' : 'false' },
      pillBar(state, input.surface.name, src),
      h('div', { class: 'pill-panel' }, body),
    )
  }
