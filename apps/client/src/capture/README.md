# client/capture — Phase 1 core (glass transplant), Phase 7 growth

**Mic capture — SHIPPED.** While a session is live the client captures the microphone and streams
timed webm/opus segments to the engine (`POST /capture/mic`, base64, `source: mic`). No session ⇒
nothing captured (privacy default — capture follows the session lifecycle the tray controls).

- `protocol.ts` — the `mic:*` IPC contract (channels + payload shapes) shared by renderer/preload/main.
- `chunk.ts` (pure) — segment → CaptureChunk (monotonic sequence, base64, contentType `audio/webm`).
- `mic-controller.ts` (pure) — the lifecycle state machine (started → permission → capturing → end +
  final-segment flush → idle; the denial path; auto-end→restart serialization; clean shutdown).
- `mic-renderer.ts` — the hidden capture window's renderer: getUserMedia + MediaRecorder, segmenting
  by stop/restart (8s complete webm files). Browser globals, not CI-tested (like shell.ts).
- `mic-preload.cts` (→ `.cjs`) — the `window.openinfoMic` contextBridge (contextIsolation on).
- `sim.ts` (P1) — the headless capture simulator; still used by the seam test.

Container = webm/opus (MediaRecorder-native). The engine STT multipart maps `audio/webm` → `audio.webm`;
accepted by ffmpeg-backed OpenAI-compatible servers (faster-whisper-server, speaches, openai). WAV via
AudioWorklet is the documented fallback for a WAV-only whisper.cpp server.

Still to come (glass transplant / later phases):
- `audio-system.ts` (system audio / loopback) + `aec/` (P1–2, pending the AEC spike) · `screen.ts`
  (Δ-diff gate, P1/P3) · `calendar.ts` (P2, read-only) · `focus.ts` (P3) · `camera.ts` (P7, flagged).
Inputs are user-configurable sources: each exposes on/off + cadence to the palette (P6).
