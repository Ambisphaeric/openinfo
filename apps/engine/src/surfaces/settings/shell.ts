import { escapeHtml, firstRunNotice, rowTemplateHtml, type SetupData } from '../setup/view.js'
import { SETTINGS_CSS, SETTINGS_SCRIPT } from './assets.js'
import { GROUP_ORDER, GROUP_LABEL, SECTIONS, defaultSectionId, sectionById, type SettingsSection } from './registry.js'

/**
 * The Settings shell — a persistent left sidebar + a content pane, server-rendered per request (no SPA,
 * no framework: the repo's hand-rolled discipline). It walks the section registry (registry.ts) to build
 * the grouped nav and render the ACTIVE section's pure body. The old
 * one-page model setup becomes a real settings surface with nested configuration, like glass / openwebui
 * Pure — the engine route hands it live data + the active id.
 */

/** SettingsData is the SetupData bag (re-homed): the shell reads whatever the sections need. */
export type SettingsData = SetupData

/** One sidebar nav item: an anchor with the active marker and an optional cheap live dot/count. */
const navItemHtml = (section: SettingsSection, activeId: string, data: SettingsData): string => {
  const active = section.id === activeId
  const dot = section.liveDot?.(data)
  const dotHtml = dot
    ? dot.suffix !== undefined
      ? `<span class="nav-count${dot.on ? ' on' : ''}">${escapeHtml(dot.suffix)}</span>`
      : `<span class="nav-dot${dot.on ? ' on' : ''}" aria-hidden="true"></span>`
    : ''
  return (
    `<a class="nav-item${active ? ' active' : ''}" href="/settings/${escapeHtml(section.id)}"${active ? ' aria-current="page"' : ''}>` +
    `<span class="nav-label">${escapeHtml(section.label)}</span>${dotHtml}</a>`
  )
}

/** The grouped sidebar nav: walk GROUP_ORDER, emit a micro-header per labelled group, then its items. */
const sidebarNavHtml = (activeId: string, data: SettingsData): string =>
  GROUP_ORDER.map((group) => {
    const items = SECTIONS.filter((s) => s.group === group)
    if (items.length === 0) return ''
    const label = GROUP_LABEL[group]
    const header = label ? `<div class="nav-glabel">${escapeHtml(label)}</div>` : ''
    return `<div class="nav-group">${header}${items.map((s) => navItemHtml(s, activeId, data)).join('')}</div>`
  }).join('')

/**
 * Render the whole Settings page for a given active section. Unknown activeId falls back to the default
 * section (so a stale link never dead-ends). Pure.
 */
export const renderSettingsPage = (data: SettingsData, activeId?: string): string => {
  const active = (activeId && sectionById(activeId)) || sectionById(defaultSectionId(data))!
  const notice = firstRunNotice(data.liveFabric)
  // The first-run nudge rides the pane on any section EXCEPT get-started (which already leads with it).
  const banner = notice && active.id !== 'get-started' ? `<div class="banner">⚠ ${escapeHtml(notice)}</div>` : ''
  const engine = data.engineLabel ? `<span class="brand-engine">${escapeHtml(data.engineLabel)}</span>` : ''
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8" />' +
    '<meta name="viewport" content="width=device-width, initial-scale=1" />' +
    `<title>openinfo · settings · ${escapeHtml(active.label)}</title>` +
    `<style>${SETTINGS_CSS}</style></head><body class="settings">` +
    '<div class="app">' +
    '<aside class="sidebar">' +
    `<div class="brand"><span class="brand-name">openinfo</span><span class="brand-sub">settings</span>${engine}</div>` +
    `<nav>${sidebarNavHtml(active.id, data)}</nav>` +
    '</aside>' +
    '<main class="pane">' +
    `<header class="pane-head"><h1>${escapeHtml(active.label)}</h1></header>` +
    `<div class="pane-body">${banner}${active.render(data)}</div>` +
    '</main>' +
    '</div>' +
    rowTemplateHtml(data.secretRefs) +
    `<script>${SETTINGS_SCRIPT}</script>` +
    '</body></html>'
  )
}
