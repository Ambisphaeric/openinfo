# client/capture — Phase 1 core (glass transplant), Phase 7 growth

**Mic capture — SHIPPED.** While a session is live the client captures the microphone and streams
timed webm/opus segments to the engine (`POST /capture/mic`, base64, `source: mic` → "me"). No session
⇒ nothing captured (privacy default — capture follows the session lifecycle the tray controls).

**System-audio capture — SHIPPED (BlackHole detect-and-guide).** While a session is live the client
ALSO captures the far side of a call ("them") when a BlackHole-like virtual audio input is present —
a SECOND MediaRecorder in the SAME hidden window, streaming to `POST /capture/system-audio` (`source:
system-audio`). Zero native code: it rides the identical `getUserMedia` path as the mic. The engine's
STT slice attributes mic="me" / system-audio="them" for free (no diarization). See ARCHITECTURE §8
(the design note weighs BlackHole vs. a native CoreAudio tap — (a) now, (b) later).

Both sources share one window / renderer / preload, keyed by `source`:

- `protocol.ts` — the `capture:*` IPC contract (channels + payloads + status, all source-tagged).
- `chunk.ts` (pure) — segment → CaptureChunk (per-source id prefix `mic-`/`sys-` so ids never collide,
  monotonic sequence, base64, contentType `audio/webm`).
- `device-match.ts` (pure) — the ordered name-pattern matcher that finds the virtual input (BlackHole
  first). The user NEVER types a device name (detection-over-configuration).
- `capture-controller.ts` (pure) — one source-agnostic lifecycle state machine per source (started →
  permission → capturing → end + final-segment flush → idle; denial; `no-device` → `unavailable`;
  system-audio silence honesty; auto-end→restart serialization; clean shutdown).
- `capture-renderer.ts` — the hidden window's renderer: per-source getUserMedia + MediaRecorder,
  segmenting by stop/restart (8s complete webm files), system-audio device match + an AnalyserNode
  silence probe. Browser globals, not CI-tested (like shell.ts).
- `capture-preload.cts` (→ `.cjs`) — the `window.openinfoCapture` contextBridge (contextIsolation on).
- `sim.ts` (P1) — the headless capture simulator; still used by the seam test.

Container = webm/opus (MediaRecorder-native). The engine STT multipart maps `audio/webm` → `audio.webm`;
accepted by ffmpeg-backed OpenAI-compatible servers (faster-whisper-server, speaches, openai). WAV via
AudioWorklet is the documented fallback for a WAV-only whisper.cpp server.

## Setting up system audio (the honest minimal recipe)

BlackHole is a virtual audio device: audio sent to its *output* is readable from its matching *input*,
which is what openinfo captures. You have to route your call/app's output into it. Two ways:

1. **Multi-Output Device** (hear the call AND capture it): open **Audio MIDI Setup** → **＋** →
   *Create Multi-Output Device* → tick both your speakers/headphones **and** *BlackHole 2ch* → set that
   Multi-Output as the system (or meeting-app) output. You keep hearing the call; a copy flows to BlackHole.
2. **Headphones + point the app at BlackHole** (simplest): wear headphones, set the meeting app's output
   device to *BlackHole 2ch*. **Headphones also remove speaker→mic echo entirely** — the cleanest setup.

Until output is routed, BlackHole delivers pure silence; the tray says so honestly (**`● rec (mic;
system silent)`**) rather than pretending to record. Once audio flows it reads **`● rec (mic + system)`**.
Install BlackHole with `brew install blackhole-2ch`. Disable the second stream entirely with
`OPENINFO_SYSTEM_AUDIO=0` (mic stays on); it is otherwise a no-op when no device is present.

Still to come (glass transplant / later phases):
- `audio-tap/` — a native CoreAudio process-tap (no user routing; the designed future, ARCHITECTURE §8)
  · `aec/` (P1–2, pending the AEC spike) · `screen.ts` (Δ-diff gate, P1/P3) · `calendar.ts` (P2,
  read-only) · `focus.ts` (P3) · `camera.ts` (P7, flagged).
Inputs are user-configurable sources: each exposes on/off + cadence to the palette (P6).
