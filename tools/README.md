# tools — dev-only
- `redeploy-remote.sh` — kill + wipe + fresh rsync/install/build/run on a remote test
  machine over ssh (`REMOTE_USER`/`REMOTE_HOST`/`REMOTE_PATH` env overrides). For dogfooding
  on a second machine, not part of the product.
- `ship-dmg-remote.sh` — rsync a built `apps/client/release/openinfo-<version>-arm64.dmg`
  to `~/Downloads` on a remote machine, to try the packaged installer itself (build it
  first with `pnpm --filter @openinfo/client dmg`).
- `schema-gen/` — TS types → JSON Schema into shared/contracts/schemas (the Rust-portable artifact)
- `bench/` — endpoint benchmark harness; writes measured tok/s into fabric via the API
- `fixtures/` — capture recorder/replayer: record a real meeting once, replay it into the
  engine deterministically. THE key tool: makes distill/extract/voice work testable without
  sitting in meetings, and turns dogfood findings into regression tests.
