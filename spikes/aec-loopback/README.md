# spike: aec-loopback (THROWAWAY)

One question: **on darwin 25 / Electron 38, can Electron capture SYSTEM AUDIO via loopback, and
does built-in `echoCancellation` (or the AEC3 far-end trick) remove speaker output from the mic —
or do we need a WASM AEC / compiled native helper later?**

Retires the remaining question in the `glass-capture` spike row (CODE_MAP §4). The answer lives in
`docs/PHASE2-NOTES.md`; this dir is the runnable proof and is deleted-or-graduated-by-rewrite.

## Run

```sh
cd spikes/aec-loopback
npm install          # electron 38, isolated (spikes/ is NOT a workspace package)
npm start            # runs the whole sequence, writes ./out/, then quits
KEEP_OPEN=1 npm start # leave the window open afterwards (to re-listen)
```

## macOS TCC permissions (the likely wall — human clicks, one-time)

Unsigned dev Electron needs two grants. If a run reports failures, grant these and re-run:

1. **Microphone** — `getUserMedia` triggers a prompt on first run. Approve it (or
   System Settings ▸ Privacy & Security ▸ Microphone ▸ enable Electron).
2. **Screen Recording** — `getDisplayMedia` (loopback) needs it. macOS may not prompt; enable
   Electron under System Settings ▸ Privacy & Security ▸ Screen Recording, then **re-run**
   (Screen-Recording grants often require an app restart to take effect).

The app runs unattended once permissions are granted. It plays an audible 440 Hz tone burst out
the **default speakers**, so verification needs real speakers + mic (headless-audio machines are
detected and reported — see `results.json` `platform.hasInput`).

## What it does / measures

- Grants `getDisplayMedia` with `audio: 'loopback'` in the main process and reports whether an
  audio track actually materialises (the headline: does native loopback work on macOS at all).
- Captures the mic in 3 configs: **A** `echoCancellation:false` (baseline leakage), **B**
  `echoCancellation:true` (option 1), **C** `echoCancellation:true` + AEC3 far-end trick routing
  the loopback stream through a local `RTCPeerConnection` (option 2).
- Per config: mic RMS during the tone vs during silence → **tone-over-floor leakage (dB)** (lower =
  more speaker output removed), plus mic↔loopback peak cross-correlation, plus whether loopback
  itself captured the tone.

## Outputs (`./out/`)

- `results.json` — all numbers + device list + loopback track info.
- `mic_A_ec_off.wav`, `mic_B_ec_on.wav`, `mic_C_ec_on_farend.wav` — mic recordings to listen to.
- `loopback.wav` — the system-audio capture (empty/absent if loopback yielded no track).
