#!/usr/bin/env bash
# THROWAWAY spike helper. Measures RAW acoustic speaker->mic leakage WITHOUT any AEC, entirely
# outside Electron — via ffmpeg (which already holds Microphone TCC on this machine) + afplay.
# This is the "option: none / baseline" number the Chromium AEC must beat. It does NOT exercise
# echoCancellation (that path is Electron-mic-TCC-walled); it proves the acoustic path is live and
# quantifies how much speaker output the mic picks up through the air.
set -euo pipefail
cd "$(dirname "$0")/out"

MIC_IDX="${MIC_IDX:-1}"          # avfoundation audio index (1 = MacBook Pro Microphone here)
VOL="${VOL:-45}"                 # output volume % for a known, repeatable playback level

rms_db() { # $1 wav -> mean/RMS volume in dB via ffmpeg volumedetect
  ffmpeg -hide_banner -nostats -i "$1" -af volumedetect -f null - 2>&1 \
    | grep -E "mean_volume|max_volume" | sed 's/^\[.*\] //'
}

echo "== baseline acoustic leakage (no AEC, via ffmpeg) =="
osascript -e "set volume output volume ${VOL}" || true
echo "output volume set to ${VOL}%"

# 440 Hz tone, 4s, played out the default speakers.
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=440:duration=4" -ar 48000 -ac 1 tone.wav

echo "-- recording 2s of SILENCE from mic idx ${MIC_IDX} --"
ffmpeg -hide_banner -loglevel error -y -f avfoundation -i ":${MIC_IDX}" -t 2 -ar 48000 -ac 1 base_silence.wav

echo "-- playing tone out speakers + recording 4s from mic --"
afplay tone.wav &
AFPID=$!
ffmpeg -hide_banner -loglevel error -y -f avfoundation -i ":${MIC_IDX}" -t 4 -ar 48000 -ac 1 base_mic_tone.wav
wait $AFPID 2>/dev/null || true

echo ""
echo "SILENCE (mic noise floor):"; rms_db base_silence.wav
echo "TONE PLAYING (mic pickup):"; rms_db base_mic_tone.wav
echo ""
echo "Wrote out/base_silence.wav, out/base_mic_tone.wav, out/tone.wav — the rise in mean/max volume"
echo "from silence to tone is the raw acoustic leakage AEC must remove."
