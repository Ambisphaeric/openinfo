import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pillStyles } from './pill-styles.js'

test('the pill gives its fixed Listen extent a bounded scrolling panel and compact lane rhythm', () => {
  assert.match(pillStyles, /\.pill-stage\{height:100vh;min-height:0;padding:8px 24px\}/)
  assert.match(pillStyles, /\.pill-stage \.pill-mount,\.pill-stage \.pill-app\{height:100%;min-height:0\}/)
  assert.match(pillStyles, /\.pill-panel\{flex:1;min-height:0;overflow-y:auto\}/)
  assert.match(pillStyles, /\.pill-panel \.sense-lane\{gap:8px;padding:3px 0\}/)
  assert.match(pillStyles, /\.pill-panel \.sense-lane \.body\{display:flex;flex-wrap:wrap;align-items:baseline;column-gap:6px\}/)
})

test('the compact lanes preserve glass tokens, add no animation, and honor reduced transparency', () => {
  assert.match(pillStyles, /background:var\(--s-glass\);backdrop-filter:blur\(20px\)/)
  assert.match(pillStyles, /@media \(prefers-reduced-transparency: reduce\)/)
  assert.match(pillStyles, /background:var\(--s-bg0\);backdrop-filter:none/)
  const laneRules = pillStyles.match(/\.pill-panel \.sense-lane[^}]*\}/g)?.join('') ?? ''
  assert.doesNotMatch(laneRules, /animation|transition/)
})
