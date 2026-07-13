# engine/api — authenticated control plane

Everything the client, Settings, and workbench see crosses this HTTP/WS boundary. Product startup must
construct it through `startEngine` in `main.ts`; `createEngineApp` requires an injected `ControlPlane` and
has no unauthenticated product default.

## Listener modes

- `local` (default): bind only a loopback host (`127/8`, `localhost`, or `::1`) and generate a new
  256-bit control token for each launch. The live record is
  `~/.openinfo/run/engine-<port>.json` (`OPENINFO_CONTROL_RUN_DIR` overrides the directory), with the
  directory mode `0700` and file mode `0600`. It is published only after `listen` succeeds and removed on
  shutdown. Never log, copy into `client.json`, or put its `token` in a URL.
- `tunnel`: the engine still binds loopback. A trusted TLS tunnel exposes the exact HTTPS
  `OPENINFO_PUBLIC_ORIGIN`; the operator must provision either `OPENINFO_CONTROL_TOKEN` or a chmod-600
  `OPENINFO_CONTROL_TOKEN_FILE`. Direct HTTP binding to a LAN/public address is refused. Cross-machine
  use is HTTPS through that tunnel, never plaintext LAN HTTP.

`OPENINFO_ALLOWED_ORIGINS` is a comma-separated exact-origin allowlist. It changes browser Origin/CORS
admission only; it never bypasses authentication.

## Request contract

- `GET /health` is the sole public route and returns only minimal liveness/version data.
- Every other read requires `Authorization: Bearer <control-token>` or an authenticated browser session.
- Every `POST`, `PUT`, and `DELETE` requires `Content-Type: application/json`, even when bodyless.
  Malformed JSON is `400`; the media-type guard is `415`.
- Guards run Host → request-target → Origin → CORS preflight → auth → Content-Type → routing/body parse.
- `/events` accepts a Bearer header or the browser-safe subprotocol pair
  `openinfo.v1, openinfo.auth.<token>` and echoes only `openinfo.v1`. Query-string credentials are refused.

Settings is opened by an authenticated native client exchanging `POST /auth/browser-ticket` for a
short-lived, one-use URL. Consuming it creates an in-memory `HttpOnly; SameSite=Strict` session cookie
(`Secure` in tunnel mode) and redirects to the clean `/settings` URL. An unauthenticated Settings request
renders only a locked shell. The two `/auth/*` bootstrap paths are deliberately engine-internal and are
not entries in the shared application `Routes` manifest.

The internal event bus keeps the full `CaptureChunk` so processors can consume raw bytes. The public
`capture.received` WS event is always a metadata-only `CaptureReceipt`; it contains no `data`, preview,
text, or hash. This control-plane rule is separate from fabric egress: an OCR/VLM endpoint receives raw
frames only on loopback unless its HTTP endpoint explicitly sets `trustRawFrames: true`, and that opt-in
is still capped to a private-LAN destination. It never authorizes access to this API.
