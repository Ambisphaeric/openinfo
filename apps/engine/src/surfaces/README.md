# engine/surfaces — Phase 4 (workbench serving), Phase 6 (custom blocks)
The rabbithole pattern: engine serves self-contained HTML surfaces.
- `serve.ts` (P4) — static serving of the built workbench
- `custom-blocks.ts` (P6) — sandboxed user blocks: shell/styles/client-chunks assembly,
  postMessage bridge with an API-only allowlist. A custom block can never reach a DB or disk.
