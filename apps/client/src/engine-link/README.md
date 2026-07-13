# client/engine-link — authenticated seam

The typed HTTP/WS client is generated from contracts. `spool.ts` buffers capture while the engine is
unreachable (unplug, spool, replug, catch up); the client never opens an engine database.

For a local engine, `EngineAuthDiscovery` loads the per-port record from
`~/.openinfo/run/engine-<port>.json`. It refuses symlinks, non-owned or group/world-accessible records,
record/URL mismatches, and plaintext non-loopback destinations. The bearer remains in Electron main:
native requests attach it only to the exact engine origin, and trusted built-in renderer `webContents`
receive an injected header after the request leaves renderer JavaScript. A `401` reloads discovery once;
every WS connect/reconnect reloads it before offering `openinfo.v1, openinfo.auth.<token>`.

For an HTTPS `publicOrigin`, the product shell uses an explicitly provisioned
`OPENINFO_CONTROL_TOKEN` or owner-only `OPENINFO_CONTROL_TOKEN_FILE` instead of guessing a discovery
filename from the public port. Keychain-backed setup UI is not built yet. Never store the token in
`client.json`, renderer state, logs, or a URL.

The standalone plain-browser HUD can serve and paint the assets, but it cannot read the private discovery
file or inject a WS Authorization header. It therefore cannot connect directly to the hardened engine by
default. Browser development needs an explicit authenticated browser-session bootstrap plus an exact
allowed Origin; the production Electron path supplies authentication automatically.

The public `capture.received` event is a `CaptureReceipt` (id/source/timing/content metadata and byte
count), not the internal `CaptureChunk`; raw capture bytes never cross the WS seam.
