import { test } from 'node:test'
import assert from 'node:assert/strict'
import { systemFaceBody, systemFaceHtml, systemFaceDataUrl, type SystemFaceModel } from './system-face.js'
import { renderToHtml } from '../surfaces/block-renderer/vnode.js'

const html = (model: SystemFaceModel): string => renderToHtml(systemFaceBody(model))

test('system face: renders the app version + build prominently', () => {
  const out = html({ appVersion: '0.0.12', appBuild: 'a1b2c3d', engineDisposition: 'spawn', engineVersion: '0.0.12', engineBuild: 'a1b2c3d' })
  assert.match(out, /This app/)
  assert.match(out, /v0\.0\.12 · build a1b2c3d/)
})

test('system face: an unstamped dev build shows the version alone (no dangling "build")', () => {
  const out = html({ appVersion: '0.0.12', engineDisposition: 'adopt', engineVersion: '0.0.12', engineUrl: 'http://127.0.0.1:8787' })
  assert.match(out, /v0\.0\.12/)
  assert.doesNotMatch(out, /build/)
})

test('system face: an adopted engine surfaces its url + version + build', () => {
  const out = html({ appVersion: '0.0.12', engineDisposition: 'adopt', engineVersion: '0.0.11', engineBuild: 'deadbee', engineUrl: 'http://127.0.0.1:8787' })
  assert.match(out, /adopted — http:\/\/127\.0\.0\.1:8787/)
  assert.match(out, /v0\.0\.11 · build deadbee/)
})

test('system face: an unreachable engine shows a dash, not a fabricated version', () => {
  const out = html({ appVersion: '0.0.12', engineDisposition: 'unreachable' })
  assert.match(out, /unreachable/)
})

test('system face: a REFUSED skew renders the hard blocking banner + reason + override hint', () => {
  const out = html({
    appVersion: '0.0.12',
    engineDisposition: 'adopt',
    engineVersion: '0.0.10',
    engineUrl: 'http://127.0.0.1:8787',
    skew: { refused: true, reason: 'engine v0.0.10 is older than this app (v0.0.12)' },
  })
  assert.match(out, /banner-refused/)
  assert.match(out, /refused/)
  assert.match(out, /older than this app/)
  assert.match(out, /OPENINFO_ALLOW_ENGINE_SKEW=1/)
})

test('system face: a dev-ALLOWED skew renders the softer amber note instead', () => {
  const out = html({
    appVersion: '0.0.12',
    engineDisposition: 'adopt',
    engineVersion: '0.0.10',
    skew: { refused: false, reason: 'engine v0.0.10 is older than this app (v0.0.12)' },
  })
  assert.match(out, /banner-allowed/)
  assert.match(out, /adopted anyway/)
})

test('system face: no skew ⇒ no banner at all', () => {
  const out = html({ appVersion: '0.0.12', engineDisposition: 'spawn', engineVersion: '0.0.12' })
  assert.doesNotMatch(out, /banner/)
})

test('systemFaceHtml: a complete self-contained document (doctype + inline style, no external assets)', () => {
  const doc = systemFaceHtml({ appVersion: '0.0.12', engineDisposition: 'spawn', engineVersion: '0.0.12' })
  assert.match(doc, /^<!doctype html>/)
  assert.match(doc, /<style>/)
  assert.doesNotMatch(doc, /src=|href=/) // nothing external to fetch (a data: URL can load no assets)
})

test('systemFaceDataUrl: encodes the whole page into a data URL for window.loadURL', () => {
  const url = systemFaceDataUrl({ appVersion: '0.0.12', engineDisposition: 'spawn', engineVersion: '0.0.12' })
  assert.match(url, /^data:text\/html;charset=utf-8,/)
  assert.match(decodeURIComponent(url), /openinfo — System/)
})
