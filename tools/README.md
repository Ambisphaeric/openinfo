# tools — dev-only
- `redeploy-remote.sh` — kill + wipe + fresh rsync/install/build/run on a remote test
  machine over ssh (`REMOTE_USER`/`REMOTE_HOST`/`REMOTE_PATH` env overrides). For dogfooding
  on a second machine, not part of the product.
- `ship-dmg-remote.sh` — rsync a built `apps/client/release/openinfo-<version>-arm64.dmg`
  to `~/Downloads` on a remote machine, to try the packaged installer itself (build it
  first with `pnpm --filter @openinfo/client dmg`).
- `reset-app-remote.command` — double-clickable one-shot: kill + wipe app state (dbs,
  secrets, config; TCC untouched) on the remote test machine, reinstall from the newest
  DMG in its `~/Downloads`, relaunch, and re-seed the llm/stt fabric endpoints against
  this machine's live LAN IP (DHCP-safe). `DRY_RUN=1` prints instead of executing.
- `schema-gen/` — TS types → JSON Schema into shared/contracts/schemas (the Rust-portable artifact)
- `workflow-governance/` — pure, non-mutating `/next` selection and `/retro` close-out model plus a
  deterministic fixture. Run `pnpm workflow:dry-run`; it never invokes `gh` or writes GitHub state.
- `bench/` — endpoint benchmark harness; writes measured tok/s into fabric via the API
- `fixtures/` — capture recorder/replayer: record a real meeting once, replay it into the
  engine deterministically. THE key tool: makes distill/extract/voice work testable without
  sitting in meetings, and turns dogfood findings into regression tests.
