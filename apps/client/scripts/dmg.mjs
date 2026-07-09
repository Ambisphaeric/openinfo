#!/usr/bin/env node
/**
 * Wrap the packaged, ad-hoc-signed `openinfo.app` into a mountable, drag-to-install
 * `openinfo-<version>-arm64.dmg` — the 0.0.1 deliverable. Uses macOS's built-in `hdiutil` (no new
 * dependency, nothing committed beyond this script) and `ditto` to copy the .app verbatim (preserving the
 * bundle's symlinks + ad-hoc signature — a plain recursive copy would mangle them).
 *
 * The DMG lays out the app alongside an `/Applications` symlink so the mount shows the familiar
 * drag-here-to-install window. Ad-hoc-signed only (no Developer ID on this machine): a downloaded copy hits
 * Gatekeeper and needs a one-time right-click → Open. NOT notarized (out of scope for 0.0.1). Artifacts land
 * in release/ (gitignored).
 *
 * `pnpm dmg` → this. It first runs the full packaging (stage engine bundle → packager → codesign) so the
 * DMG always wraps a fresh, engine-complete app.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { packageApp } from './package.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(__dirname, '..')
const outDir = path.join(appDir, 'release')
const version = JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf8')).version || '0.0.0'

const app = await packageApp()
const dmgPath = path.join(outDir, `openinfo-${version}-arm64.dmg`)

// Stage a mount layout: the app + an /Applications symlink (drag-to-install).
const stage = mkdtempSync(path.join(tmpdir(), 'openinfo-dmg-'))
console.log(`[dmg] staging mount layout in ${stage}`)
execFileSync('ditto', [app, path.join(stage, 'openinfo.app')], { stdio: 'inherit' }) // verbatim: symlinks + signature
symlinkSync('/Applications', path.join(stage, 'Applications'))

rmSync(dmgPath, { force: true })
console.log(`[dmg] creating ${dmgPath}`)
execFileSync(
  'hdiutil',
  ['create', '-volname', 'openinfo', '-srcfolder', stage, '-ov', '-format', 'UDZO', dmgPath],
  { stdio: 'inherit' },
)
rmSync(stage, { recursive: true, force: true })
console.log(`\n[dmg] built: ${dmgPath}`)
console.log('[dmg] install: open the DMG, drag openinfo → Applications. First launch: right-click → Open (ad-hoc-signed).')
