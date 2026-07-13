# client/capture — Phase 1 core (glass transplant), Phase 7 growth

**Mic capture — SHIPPED.** While a session is live the client captures the microphone and streams
timed webm/opus segments to the engine (`POST /capture/mic`, base64, `source: mic` → "me"). No session
⇒ nothing captured (privacy default — capture follows the session lifecycle the tray controls).

**System-audio capture — SHIPPED (two open paths, #142).** While a session is live the client ALSO
captures the far side of a call ("them") — a SECOND MediaRecorder in the SAME hidden window, streaming to
`POST /capture/system-audio` (`source: system-audio`). The engine's STT slice attributes mic="me" /
system-audio="them" for free (no diarization). HOW the second stream opens is `ShellConfig.systemAudioMethod`
(config.ts, env > file > `auto`):

- `loopback` (#142, the **macOS default** via `auto`) — the NO-ROUTING path: Chromium's macOS CoreAudio-Tap.
  The main process grants the hidden renderer's `getDisplayMedia({audio:'loopback'})` via
  `session.setDisplayMediaRequestHandler` (shell.ts); the renderer keeps only the audio track (the system
  mix) and drops the video track getDisplayMedia requires. NO virtual-device install, NO Multi-Output
  routing — the far side is captured out of the box once the one-time **Screen & System Audio Recording**
  TCC grant is given. Requires the `NSAudioCaptureUsageDescription` Info.plist key (packaged in package.mjs)
  and the `MacCatapLoopbackAudioForScreenShare` feature switch (default from Electron v39; explicit on v38);
  a missing grant/plist yields a DEAD (digital-silence) stream, which the silence probe below flags honestly.
- `device` (the shipped floor / `auto` off macOS) — the BlackHole detect-and-guide path: a 2nd `getUserMedia`
  on a matched BlackHole-class virtual INPUT (device-match.ts). Needs the user to install + route output
  through it, but needs no OS recording grant.

Both paths feed the identical MediaRecorder/VAD/chunk/silence pipeline downstream — only *how the second
stream opens* differs, exactly the source-agnostic seam ARCHITECTURE §8 set up. See ARCHITECTURE §8 for the
route-(a)/(b) decision record (the Chromium tap is route (b) achieved with ZERO native code of our own).

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
  segmenting by stop/restart (complete webm files). WHERE it cuts is `ShellConfig.chunkStrategy` (#95):
  `vad` (default) rotates at a detected PAUSE via the AnalyserNode amplitude poll so a cut never splits a
  word (measured whole-file-equal, vs ~0.20 WER at the old fixed-1s — `tools/stt-accuracy`); `fixed` keeps
  the wall-clock `segmentMs` cadence (#57). System-audio device match + the silence probe as before.
- `vad.ts` — PURE pause-based rotation decision (`shouldRotate`/`nextSilenceRunMs`/`resolveVadParams`,
  `DEFAULT_VAD_PARAMS`); the renderer feeds it amplitude telemetry. Unit-tested (`vad.test.ts`); the
  renderer's fixed + vad rotation wiring is unit-tested (`capture-renderer.test.ts`).
- `capture-preload.cts` (→ `.cjs`) — the `window.openinfoCapture` contextBridge (contextIsolation on).
- `sim.ts` (P1) — the headless capture simulator; still used by the seam test.

Container = webm/opus (MediaRecorder-native). The engine STT multipart maps `audio/webm` → `audio.webm`;
accepted by ffmpeg-backed OpenAI-compatible servers (faster-whisper-server, speaches, openai). WAV via
AudioWorklet is the documented fallback for a WAV-only whisper.cpp server.

## Setting up system audio (the honest minimal recipe)

On macOS the default is now `loopback` (no setup — grant **Screen & System Audio Recording** once when
prompted and the far side is captured; if it stays silent, the readout points at the grant + relaunch).
The recipe below is the `device` path — the BlackHole fallback for pre-13 macOS or `systemAudioMethod=device`.

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

**Screen capture — SHIPPED, opt-in.** While a consented session is live, the main process grabs a still
frame every 3–6 seconds, applies the per-display delta gate, and durably POSTs/spools accepted JPEGs plus
their adjacent `ScreenFrameMeta` chunks. `screen-observation.ts` wraps each tick with one canonical id/time
and reports a metadata-only outcome to authenticated `POST /screen/observations`: `queued` only after the
exact image chunk is durably accepted, otherwise `delta-skipped` or `grab-failed`. Observation reports
contain no pixels/text/preview/hash/error/display metadata and are deliberately ephemeral (never spooled),
so a read-model outage cannot interrupt capture. `CaptureController.onSegment` returns the exact accepted
primary chunk for this correlation; companion metadata failure cannot revoke a durable image receipt.

**Focus capture — SHIPPED (foreground-window context, P3).** A main-process poller samples the
frontmost app + window title on a modest cadence (~3s) and emits a `FocusSignal` ONLY on change. It is
CONTEXT, not media: no hidden renderer, no getUserMedia, no session — it watches to feed the engine's
context-switch detector, including when NO session is live (focus is what STARTS sessions). It rides the
ordinary capture seam as an utf8/JSON CaptureChunk (`source: 'focus'`, `contentType: application/json`,
`data` = JSON.stringify(FocusSignal)); the detector decodes it and EXCLUDES it from transcripts/moments.

- `focus.ts` (pure) — `FrontmostWindow` → redacted `FocusSignal`; ordered dev-app repo rules (VS
  Code/Cursor root name, Terminal/iTerm path token); conservative best-effort secret redaction; the
  dedupe key; focus CaptureChunk shaping (sentinel sessionId — focus flows OUTSIDE sessions).
- `focus-poller.ts` (pure) — a dedicated low-rate poller (NOT CaptureController: no renderer,
  session-independent, gated differently). Privacy gate: polls ONLY when the engine's `route.detect`
  flag is ON **and** the client-local `OPENINFO_FOCUS` opt-out is not set — off ⇒ no polling at all (the
  timer is cleared), never poll-and-drop. On-change dedupe + a burst-emit throttle.
- The OS read (osascript / System Events for the frontmost app + title) lives in `shell.ts` — the thin
  electron/OS edge, not CI-tested (like the capture renderer). Emitted via `EngineLink.captureEphemeral`
  (never spooled — a stale "which window 10 min ago" is noise, not data loss).

**Focus privacy + TCC (macOS).** Reading another app's process/window via System Events needs
**Accessibility** (System Settings → Privacy & Security → Accessibility → enable the running app). Until
granted the reader returns nothing and no focus flows. The app NAME is the reliable floor; window TITLES
depend on the app exposing an AX front-window title (and on some apps a Screen Recording grant), so title
capture is best-effort. Titles are scrubbed (`redactTitle`) before emission and can be disabled entirely
with `OPENINFO_FOCUS=0`. FUTURE: a reviewed native reader replaces osascript behind the same `sample()`
seam; a `git -C` / native resolution replaces the title-derived `repoPath` heuristic with a true root.

Still to come (glass transplant / later phases):
- The `loopback` path (#142) delivers the no-routing capture ARCHITECTURE §8 called route (b) WITHOUT a
  native module of our own (Chromium's CoreAudio-Tap does the tapping). Its live capture needs a packaged,
  TCC-granted app to verify end-to-end (an unsigned dev run has no bundle identity to grant against) —
  follow-up: confirm on a packaged run + a physical audio source, then consider Electron 39 (tap is the
  default there), and an auto-fallback to `device` when the tap yields silence.
- `audio-tap/` — a from-source native CoreAudio process-tap, only if the Chromium tap ever proves
  insufficient (no user routing; ARCHITECTURE §8 route (b)-native)
  · `aec/` (P1–2, pending the AEC spike) · `calendar.ts` (P2,
  read-only) · `camera.ts` (P7, flagged).
Inputs are user-configurable sources: each exposes on/off + cadence to the palette (P6).
