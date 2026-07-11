#!/usr/bin/env node
/**
 * Package the client as a real, double-clickable macOS `openinfo.app` (arm64), ad-hoc signed so it owns
 * its OWN TCC identity — the whole point of this slice. An UNSIGNED `electron .` dev run has no bundle
 * identity, so macOS attributes its permission requests to the LAUNCHING process (Terminal/launchd) and
 * the app's own dialogs never appear. A packaged, ad-hoc-signed .app is a proper bundle: it prompts for
 * mic / Local Network under its own name and its Accessibility grant sticks to the bundle.
 *
 * SINCE 0.0.1 the app is NOT a dead shell: it ships the ENGINE, bundled as a repo-shaped `engine-bundle/`
 * extraResource, and the shell spawns it on first launch when nothing already answers :8787 (see
 * engine-supervisor.ts). This script stages that bundle: build engine dist, deploy a hoisted (symlink-free)
 * prod node_modules, rebuild the ONE native module (better-sqlite3) for Electron's ABI, and lay it out as
 * `engine-bundle/apps/engine/{dist,node_modules,package.json}` + `engine-bundle/shared/contracts/examples`
 * so the engine's compiled, repo-relative data-file paths resolve unchanged — the engine source is consumed
 * as-is, never patched.
 *
 * WHY @electron/packager (not electron-builder): we want an unsigned/ad-hoc DEV app, not a notarized
 * distributable — packager produces exactly the .app bundle we need with far less machinery. No
 * notarization, no auto-update, no installer — all out of scope.
 *
 * RUNTIME/ABI decision (0.0.1): the engine runs in Electron's `utilityProcess` — Electron's OWN bundled
 * Node — so there is NO second Node runtime to ship. better-sqlite3's prebuilt binary is then fetched for
 * Electron's Node ABI (`prebuild-install -r electron -t <electronVersion>`) — official WiseLibs prebuild,
 * no node-gyp/Xcode compile at package time. See engine-supervisor.ts + shell.ts (ensureEngine).
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
import { readFileSync, rmSync, mkdirSync, cpSync } from 'node:fs'
import path from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appDir = path.resolve(__dirname, '..') // apps/client
const repoRoot = path.resolve(appDir, '..', '..')
const outDir = path.join(appDir, 'release')
const require = createRequire(import.meta.url)

const pkg = JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf8'))
const electronVersion = require('electron/package.json').version

// Honest, session-gated usage strings — shown verbatim in the OS permission dialogs.
const extendInfo = {
  NSMicrophoneUsageDescription:
    'openinfo listens to your microphone only while a session is live, to transcribe the conversation into your notes locally. No session, no listening.',
  // #142: REQUIRED for macOS 14.2+ system-audio capture — Chromium's CoreAudio-Tap (the no-routing loopback
  // path getDisplayMedia uses) reads system audio only when this key is present; without it the OS hands back
  // a DEAD (digital-silence) stream with no error. Shown verbatim in the Screen & System Audio Recording grant.
  NSAudioCaptureUsageDescription:
    'openinfo captures your system audio (the far side of calls and media) only while a session is live, to transcribe it into your notes locally. No session, no capture.',
  NSLocalNetworkUsageDescription:
    'openinfo reaches model servers and engines on your local network (LM Studio, Ollama, or an engine on another machine) to run your local AI.',
  // Menu-bar-only agent: no Dock icon (app.dock.hide() already hides it at runtime; this avoids a launch flash).
  LSUIElement: true,
}

/**
 * Stage the engine as a repo-shaped `engine-bundle/` under release/ (gitignored), ready to hand packager as
 * an extraResource. Reproduces the minimal repo layout the engine's compiled paths expect, and rebuilds the
 * one native module for Electron's ABI. Returns the bundle dir. All work stays under release/, so it never
 * touches apps/engine/node_modules — the owner's dev engine keeps its own (system-Node) build untouched.
 */
export function stageEngineBundle() {
  const bundleDir = path.join(outDir, 'engine-bundle')
  const deployDir = path.join(outDir, '.engine-deploy')
  console.log('[package] staging bundled engine…')
  rmSync(bundleDir, { recursive: true, force: true })
  rmSync(deployDir, { recursive: true, force: true })

  // Build the engine dist (and its contracts dependency) fresh, then deploy a self-contained, symlink-free
  // (hoisted) PROD node_modules so nothing dangles when copied into the .app.
  execFileSync('pnpm', ['--filter', '@openinfo/contracts', 'build'], { cwd: repoRoot, stdio: 'inherit' })
  execFileSync('pnpm', ['--filter', '@openinfo/engine', 'build'], { cwd: repoRoot, stdio: 'inherit' })
  execFileSync(
    'pnpm',
    ['--filter', '@openinfo/engine', 'deploy', '--prod', '--config.node-linker=hoisted', deployDir],
    { cwd: repoRoot, stdio: 'inherit' },
  )

  // Rebuild the ONE native module for Electron's Node ABI (utilityProcess runs under Electron's Node, not
  // system Node). prebuild-install fetches the official electron-vNNN prebuilt — no node-gyp/Xcode compile.
  const bsqlite = path.join(deployDir, 'node_modules', 'better-sqlite3')
  const prebuildInstall = path.join(deployDir, 'node_modules', '.bin', 'prebuild-install')
  console.log(`[package] rebuilding better-sqlite3 for Electron ${electronVersion} ABI…`)
  execFileSync(prebuildInstall, ['-r', 'electron', '-t', electronVersion, '--force'], { cwd: bsqlite, stdio: 'inherit' })

  // Drop the node_modules/.bin symlinks — install-time only, and the only symlinks left in the tree (we want
  // a fully real, self-contained bundle inside the .app).
  rmSync(path.join(deployDir, 'node_modules', '.bin'), { recursive: true, force: true })

  // Lay out the repo-shaped bundle: engine-bundle/apps/engine/{dist,node_modules,package.json} +
  // engine-bundle/shared/contracts/examples. From engine-bundle/apps/engine/dist/api, the engine's
  // hardcoded `../../../../shared/contracts/examples` resolves to engine-bundle/shared/contracts/examples.
  const engineOut = path.join(bundleDir, 'apps', 'engine')
  mkdirSync(engineOut, { recursive: true })
  cpSync(path.join(deployDir, 'dist'), path.join(engineOut, 'dist'), { recursive: true })
  cpSync(path.join(deployDir, 'node_modules'), path.join(engineOut, 'node_modules'), { recursive: true })
  cpSync(path.join(deployDir, 'package.json'), path.join(engineOut, 'package.json'))
  cpSync(
    path.join(repoRoot, 'shared', 'contracts', 'examples'),
    path.join(bundleDir, 'shared', 'contracts', 'examples'),
    { recursive: true },
  )
  rmSync(deployDir, { recursive: true, force: true })
  console.log(`[package] engine bundle staged: ${bundleDir}`)
  return bundleDir
}

/** Run @electron/packager (with the staged engine bundle as an extraResource) and ad-hoc codesign. */
export async function packageApp() {
  const engineBundle = stageEngineBundle()
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
    // Ship the bundled engine into Contents/Resources/engine-bundle. The shell spawns it on first launch
    // when nothing already answers the engine URL (adopt-not-collide). See engine-supervisor.ts.
    extraResource: [engineBundle],
    // The client itself has NO runtime node_modules dependency (contracts is compile-time types only), so we
    // ship just its compiled dist + the two HTML hosts and skip node_modules/sources — a lean client bundle.
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
  const app = path.join(built, 'openinfo.app')
  // Ad-hoc codesign so the bundle owns a TCC identity. --deep covers the Electron helpers inside the bundle.
  console.log(`[package] ad-hoc codesigning ${app}`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--verbose=2', app], { stdio: 'inherit' })
  console.log(`\n[package] built + ad-hoc-signed: ${app}`)
  console.log('[package] run it:  open ' + app)
  console.log('[package] engine: spawns the bundled engine unless one already answers the configured URL')
  console.log('[package] engine URL comes from ~/.openinfo/client.json, else env (OPENINFO_ENGINE_URL), else http://127.0.0.1:8787')
  return app
}

// Run only when invoked directly (`node scripts/package.mjs`); a plain import (scripts/dmg.mjs) does not.
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) await packageApp()
