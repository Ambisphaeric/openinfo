# spike: system-audio loopback (Chromium CoreAudio-Tap) — #142

**Question.** Does Electron 38's macOS loopback path (`getDisplayMedia({audio:'loopback'})` +
`setDisplayMediaRequestHandler`, feature `MacCatapLoopbackAudioForScreenShare`) expose a system-audio
track — i.e. can we capture system audio with NO virtual device and NO routing? This retires the stale
PHASE2 `aec-loopback` verdict ("loopback is Windows-only"), which predates Chromium's CoreAudio-Tap and
was confounded by a denied Screen-Recording TCC + a missing `NSAudioCaptureUsageDescription` plist key.

**Run** (needs a GUI macOS session; uses the client's already-installed Electron 38):

```
../../apps/client/node_modules/.bin/electron main.mjs
```

Look for the `SPIKE_RESULT {...}` lines.

**Finding (Electron 38.8.6, macOS 26.3.1, unsigned dev run).**
- The **API surface EXISTS**: `setDisplayMediaRequestHandler` accepts `{ video, audio: 'loopback' }` and
  `navigator.mediaDevices.getDisplayMedia` is present in the renderer (once loaded from a real file — a
  `data:` URL is not a secure context, so getDisplayMedia is undefined there).
- But on an **unsigned dev run the call stalls at the OS wall**: `getDisplayMedia` never resolves and the
  request handler is never even invoked, because macOS gates screen/system-audio capture on a TCC grant
  an `electron .` process (no bundle identity) cannot obtain. Same two walls PHASE2 documented.

**Conclusion.** The mechanism is real and one packaged, TCC-granted run away from working; it cannot be
driven end-to-end in an automated/unsigned environment. The product wiring (`capture-renderer.ts` loopback
branch, `shell.ts` grant handler + feature switch, `package.mjs` plist key, `config.ts` `systemAudioMethod`
default `auto`→loopback on macOS) ships behind honest degradation — a grant/plist-less tap yields a dead
(silent) stream the tray flags, never fakes. See docs/PHASE4-NOTES.md (#142) and ARCHITECTURE §8.

Throwaway — `spikes/` is unimportable (CONTRIBUTING rule 6); nothing in the app depends on this.
