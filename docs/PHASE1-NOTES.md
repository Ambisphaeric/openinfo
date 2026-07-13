# Phase 1 Notes

## Decisions and Deviations

- Bus: `~/Apps/Monorepo/loom/packages/bus` was read and attributed in `apps/engine/src/bus/bus.ts`. The loom implementation depends on loom-only packages (`@loomai/types`, flow control, session graph, resilience), so Phase 1 uses a minimal typed pub/sub equivalent instead of transplanting those dependencies.
- Client: no Electron code was added in Phase 1. The seam is proven with `apps/client/src/capture/sim.ts`, a headless simulator for fake mic/screen chunks.
- Queue v0: raw capture chunks append to per-session JSONL files under `$OPENINFO_DATA/queue`. The drain loop is intentionally a no-op processor for Phase 1 and garbage-collects drained files after renaming them out of the pending path.
- Fabric v0: HTTP endpoints are checked with `GET` and a timeout. Local endpoint health is a stub until managed local runtimes land.
- Store: `_meta.db` stores versioned config documents such as fabric and flags; each workspace gets its own SQLite file in the same data root.
- Workbench: the package remains a Phase 4 scaffold. Its build/test scripts are no-ops in Phase 1 because there is no Vite app yet.

## 2026-07-12 — deterministic pipeline fixtures (#32)

- `tools/fixtures` is now a workspace package with `record`, `validate`, and `replay` CLI modes plus a
  pure library seam. Format v1 records normalized capture chunks and canonical STT/OCR/VLM boundary
  outputs; every entry retains an explicit mic, system-audio, or screen lane and references exactly one
  earlier capture id. It does not claim live OCR quality — #175 still owns proof on real frames.
- Replays are deterministic and isolated: canonical object-key ordering, contiguous ordinals,
  content-derived entry/fixture ids, a fixed replay clock, a resettable stable id factory, and a digest
  checked before callbacks. Capture-scoped invokers reject byte/source mismatch and never call a model or
  network endpoint.
- Privacy is structural rather than advisory: any inline audio/image payload is declared by
  `privacy.rawMedia` and requires record-time opt-in; real media requires sensitive classification and an
  owner-only gitignored path. The CLI emits payload-free summaries and re-pins `0600` on overwrite.
- The committed fixture is synthetic and includes separate mic/system-audio audio, screen image/frame
  metadata, two STT results, OCR blocks/provenance, and a VLM result. The first
  `screen/processor.test.ts` case now consumes it through the real processor/store, replays twice, and
  proves the resulting OcrResult + mirror Distillate are byte-identical and idempotent.

## Known flake (observed once, 2026-07-07)
- `seam.test.ts` acquires a free port then releases it before the engine binds it (TOCTOU). Under
  parallel load another process can steal the port between release and bind → one spurious failure.
  Fix when it annoys: engine binds port 0 and prints its port; the restart leg keeps the same port,
  so EngineLink needs a mutable baseUrl first. Not worth the churn in Phase 1.
