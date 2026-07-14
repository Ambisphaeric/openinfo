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
- `fixtures/` — versioned, schema-validated capture/STT/OCR/VLM recorder/replayer. It keeps mic,
  system-audio, and screen lanes distinct; derives stable ids/digests with canonical JSON; defaults to
  privacy-safe fail-closed recording; and replaces model/network boundaries during replay. The committed
  synthetic fixture drives the real screen processor twice to prove byte-identical, idempotent downstream
  records. See `fixtures/README.md`; run `pnpm --filter @openinfo/fixtures test`.
- `vision-live/` — owner-run #175 real-frame OCR/VLM validator. It captures only its generated PII-free
  full-screen card, runs the legacy OCR and workflow VLM owners against an explicitly trusted LAN endpoint,
  exercises a concurrent Gemma-12B-class workload, and writes a private payload-free latency/queue/memory
  report without changing the owner's live engine data. It asserts persisted `lan-local` + explicit-trust
  provenance and rejects URLs/credentials in that provenance. See `vision-live/README.md`; run `pnpm vision:live`.
