import type { SetupData } from '../../setup/view.js'

/**
 * The Privacy & access section — v0 static-honest. Permissions (Microphone, Accessibility, Local
 * Network) are macOS TCC grants owned by the CLIENT app; this page is engine-served and reachable from
 * any browser (including against a remote engine), so it CANNOT detect grant state without new client→
 * engine plumbing. Rather than fake a status, it says plainly what each permission is for, where to grant
 * it, and that live state + one-click fix-its live in the menu-bar tray (mirroring permission-help.ts).
 *
 * This is deliberately honest about what can't be known from here — the research doc's option (a): the
 * engine page shows instructions + honest can't-detect notes, not invented state (settings-ia-and-alignment.md,
 * open question 3). Live TCC detection would be a later client-owned affordance.
 */

interface Grant {
  title: string
  what: string
  where: string
  /** the System Settings pane a user opens to grant it */
  pane: string
}

const GRANTS: readonly Grant[] = [
  {
    title: 'Microphone',
    what: 'Capturing your side of a call ("me") for transcription and distillation. Only used while a session is live.',
    where: 'System Settings → Privacy & Security → Microphone → enable openinfo.',
    pane: 'Privacy & Security → Microphone',
  },
  {
    title: 'Accessibility',
    what: 'Reading the frontmost window title + app so context-detection (route.detect) can route sessions to the right workspace. Never types or clicks.',
    where: 'System Settings → Privacy & Security → Accessibility → enable openinfo.',
    pane: 'Privacy & Security → Accessibility',
  },
  {
    title: 'Local Network',
    what: 'Only when your engine runs on another machine on your LAN (not localhost). macOS may prompt on first reach.',
    where: 'System Settings → Privacy & Security → Local Network → enable openinfo.',
    pane: 'Privacy & Security → Local Network',
  },
]

const grantCard = (g: Grant): string =>
  `<div class="card priv-card"><div class="stat-title">${g.title}</div>` +
  `<div class="priv-what">${g.what}</div>` +
  `<div class="priv-where">${g.where}</div></div>`

/** The Privacy section body. Pure and static (v0). */
export const renderPrivacy = (_data: SetupData): string =>
  '<div class="sub">openinfo captures locally and only what you turn on. These permissions are granted to ' +
  'the desktop app by macOS — this page can’t read their state (it may be serving a remote engine to a ' +
  'browser), so it tells you what each is for and where to grant it. The menu-bar tray shows live status ' +
  'and one-click fix-its when a permission is blocked.</div>' +
  '<div class="priv-grid">' +
  GRANTS.map(grantCard).join('') +
  '</div>' +
  '<div class="stat-defer">Live grant/blocked state is shown in the menu-bar tray (it runs in the app and ' +
  'can see TCC). A browser page can’t detect it — so nothing here is invented. Everything openinfo stores ' +
  'stays on this machine; keys are write-only (never re-shown) under Keys.</div>'
