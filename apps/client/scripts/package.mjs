#!/usr/bin/env node
/**
 * Package the client as a real, double-clickable macOS `openinfo.app` (arm64), ad-hoc signed so it owns
 * its OWN TCC identity — the whole point of this slice. An UNSIGNED `electron .` dev run has no bundle
 * identity, so macOS attributes its permission requests to the LAUNCHING process (Terminal/launchd) and
 * the app's own dialogs never appear. A packaged, ad-hoc-signed .app is a proper bundle: it prompts for
 * mic / Local Network under its own name and its Accessibility grant sticks to the bundle.
 *
 * WHY @electron/packager (not electron-builder): we want an unsigned/ad-hoc DEV app, not a notarized
 * distributable — packager produces exactly the .app bundle we need with far less machinery. No
 * notarization, no auto-update, no installer — all out of scope.
 *
 * AD-HOC SIGNING CAVEAT (documented honestly): `codesign -s -` gives an ad-hoc identity that CHANGES on
 * every rebuild, so macOS treats each rebuilt app as a new identity and RE-PROMPTS for permissions after
 * a rebuild (and prior grants may need re-approving). The upgrade path is a stable self-signed cert
 * (`security create-keychain` + a self-signed codesigning identity, then `-s "openinfo dev"`): a constant
 * identity keeps grants across rebuilds without paying for a Developer ID. See docs/PHASE3-NOTES.md.
 *
 * CI is unaffected: `pnpm -r build` / `-r test` never call this — packaging is an explicit `pnpm package`.
 */
import { packager } from '@electron/packager'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(__dirname, '..') // apps/client
const outDir = path.join(appDir, 'release')
const require = createRequire(import.meta.url)

const pkg = JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf8'))
const electronVersion = require('electron/package.json').version

// Honest, session-gated usage strings — shown verbatim in the OS permission dialogs.
const extendInfo = {
  NSMicrophoneUsageDescription:
    'openinfo listens to your microphone only while a session is live, to transcribe the conversation into your notes locally. No session, no listening.',
  NSLocalNetworkUsageDescription:
    'openinfo reaches model servers and engines on your local network (LM Studio, Ollama, or an engine on another machine) to run your local AI.',
  // Menu-bar-only agent: no Dock icon (app.dock.hide() already hides it at runtime; this avoids a launch flash).
  LSUIElement: true,
}

const appPath = async () => {
  const [built] = await packager({
    dir: appDir,
    out: outDir,
    overwrite: true,
    platform: 'darwin',
    arch: 'arm64',
    name: 'openinfo',
    appBundleId: 'ai.openinfo.client',
    appVersion: pkg.version || '0.0.0',
    appCategoryType: 'public.app-category.productivity',
    electronVersion,
    derefSymlinks: true,
    prune: false, // pnpm workspace; the sole workspace dep (@openinfo/contracts) is type-only — see ignore below
    extendInfo,
    // The client has NO runtime node_modules dependency (contracts is compile-time types only), so we ship
    // just the compiled dist + the two HTML hosts and skip node_modules/sources entirely — a lean bundle.
    ignore: [
      /^\/node_modules($|\/)/,
      /^\/src($|\/)/,
      /^\/release($|\/)/,
      /^\/scripts($|\/)/,
      /^\/dist\/.*\.test\.js$/,
      /^\/dist\/.*\.js\.map$/,
      /^\/dist\/.*\.d\.ts$/,
      /\.ts$/,
      /^\/tsconfig\.json$/,
      /^\/README\.md$/,
    ],
  })
  return path.join(built, 'openinfo.app')
}

const app = await appPath()
// Ad-hoc codesign so the bundle owns a TCC identity. --deep covers the Electron helpers inside the bundle.
console.log(`[package] ad-hoc codesigning ${app}`)
execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', app], { stdio: 'inherit' })
execFileSync('codesign', ['--verify', '--verbose=2', app], { stdio: 'inherit' })
console.log(`\n[package] built + ad-hoc-signed: ${app}`)
console.log('[package] run it:  open ' + app)
console.log('[package] engine URL comes from ~/.openinfo/client.json, else env (OPENINFO_ENGINE_URL), else http://127.0.0.1:8787')
