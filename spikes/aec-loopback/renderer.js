// THROWAWAY SPIKE renderer. nodeIntegration is on, so we require() electron/node directly.
const { ipcRenderer } = require('electron');

const logEl = document.getElementById('log');
function log(...a) {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  // console.log is forwarded to the terminal by main.js; also show in-window.
  console.log(line);
  logEl.textContent += line + '\n';
}

const SR = 48000;                 // AudioContext sample rate we request
const TONE_HZ = 440;              // known played phrase = a pure tone burst
const results = { platform: {}, loopback: {}, configs: {}, notes: [] };

// ---- WAV writer (16-bit PCM mono) so a human can listen to what we measured. ----
function encodeWav(float32, sampleRate) {
  const n = float32.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const wr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  wr(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); wr(8, 'WAVE');
  wr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  wr(36, 'data'); dv.setUint32(40, n * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    let s = Math.max(-1, Math.min(1, float32[i]));
    dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
  }
  return new Uint8Array(buf);
}
function u8ToB64(u8) {
  let s = ''; const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}
async function saveWav(name, float32) {
  const b64 = u8ToB64(encodeWav(float32, SR));
  await ipcRenderer.invoke('save', name, b64);
}

const rms = (arr) => { let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i] * arr[i]; return Math.sqrt(s / (arr.length || 1)); };
const db = (x) => 20 * Math.log10(x + 1e-12);

// Normalised cross-correlation of two equal-length signals over ±maxLag (peak value).
function maxXcorr(a, b, maxLag) {
  const n = Math.min(a.length, b.length);
  const na = Math.sqrt(a.reduce((s, x) => s + x * x, 0)) + 1e-12;
  const nb = Math.sqrt(b.reduce((s, x) => s + x * x, 0)) + 1e-12;
  let best = 0;
  for (let lag = -maxLag; lag <= maxLag; lag += 8) {
    let s = 0;
    for (let i = 0; i < n; i++) { const j = i + lag; if (j >= 0 && j < n) s += a[i] * b[j]; }
    const c = Math.abs(s / (na * nb));
    if (c > best) best = c;
  }
  return best;
}

// Capture raw PCM from a MediaStream via ScriptProcessor (deprecated but simplest & reliable).
// Returns { samples: Float32Array, stop() }. Routed through a zero-gain sink so the graph is
// pulled WITHOUT feeding the mic back to the speakers.
function tap(ctx, stream) {
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const sink = ctx.createGain(); sink.gain.value = 0;
  const chunks = [];
  const marks = [];   // {t, i} — ctx time at the start of each block, and sample index
  let total = 0;
  proc.onaudioprocess = (e) => {
    const inp = e.inputBuffer.getChannelData(0);
    marks.push({ t: ctx.currentTime, i: total });
    const c = new Float32Array(inp.length); c.set(inp); chunks.push(c); total += inp.length;
  };
  src.connect(proc); proc.connect(sink); sink.connect(ctx.destination);
  return {
    marks,
    stop() {
      try { src.disconnect(); proc.disconnect(); sink.disconnect(); } catch {}
      const out = new Float32Array(total); let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.length; }
      return out;
    },
  };
}

// RMS of the slice of `samples` whose ctx-time falls in [t0,t1], using block marks.
function rmsWindow(samples, marks, t0, t1) {
  let lo = samples.length, hi = 0;
  for (let k = 0; k < marks.length; k++) {
    if (marks[k].t >= t0 && marks[k].t < t1) { lo = Math.min(lo, marks[k].i); hi = Math.max(hi, marks[k].i + 4096); }
  }
  if (hi <= lo) return { rms: 0, n: 0 };
  hi = Math.min(hi, samples.length);
  return { rms: rms(samples.subarray(lo, hi)), n: hi - lo, lo, hi };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- get the system-audio (loopback) stream via getDisplayMedia (main grants audio:'loopback') ----
async function getLoopback() {
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const aTracks = s.getAudioTracks();
    const vTracks = s.getVideoTracks();
    results.loopback.gotStream = true;
    results.loopback.audioTracks = aTracks.length;
    results.loopback.videoTracks = vTracks.length;
    results.loopback.audioSettings = aTracks[0] ? aTracks[0].getSettings() : null;
    results.loopback.audioLabel = aTracks[0] ? aTracks[0].label : null;
    log('LOOPBACK getDisplayMedia ok — audioTracks:', aTracks.length, 'videoTracks:', vTracks.length,
        aTracks[0] ? ('label=' + aTracks[0].label) : '(NO AUDIO TRACK)');
    // We don't need the screen video; stop it to drop the capture indicator load.
    vTracks.forEach((t) => t.stop());
    if (aTracks.length === 0) { s.getTracks().forEach((t) => t.stop()); return null; }
    return new MediaStream(aTracks);
  } catch (err) {
    results.loopback.gotStream = false;
    results.loopback.error = String(err && (err.name + ': ' + err.message));
    log('LOOPBACK getDisplayMedia FAILED:', results.loopback.error);
    return null;
  }
}

async function getMic(constraints) {
  return navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
}

// Set up the AEC3 "far-end" trick: pump the loopback stream through a local RTCPeerConnection
// loop and play the received copy, so Chromium registers it as a render/far-end reference.
async function farEndLoop(ctx, loopbackStream) {
  if (!loopbackStream) return null;
  const pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
  pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate);
  pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate);
  const played = new Promise((res) => {
    pc2.ontrack = (e) => {
      const el = new Audio(); el.srcObject = new MediaStream([e.track]); el.play().catch(() => {});
      res(el);
    };
  });
  loopbackStream.getAudioTracks().forEach((t) => pc1.addTrack(t, loopbackStream));
  const offer = await pc1.createOffer(); await pc1.setLocalDescription(offer);
  await pc2.setRemoteDescription(offer);
  const answer = await pc2.createAnswer(); await pc2.setLocalDescription(answer);
  await pc1.setRemoteDescription(answer);
  await played;
  return { pc1, pc2 };
}

// Run one mic configuration: record mic + loopback while playing a tone burst, then measure.
async function runConfig(name, micConstraints, loopbackStream, useFarEnd) {
  log(`\n=== config ${name} === constraints=${JSON.stringify(micConstraints)} farEnd=${!!useFarEnd}`);
  const ctx = new AudioContext({ sampleRate: SR });
  await ctx.resume();

  let farEnd = null;
  if (useFarEnd) {
    try { farEnd = await farEndLoop(ctx, loopbackStream); log('far-end RTCPeerConnection loop established'); }
    catch (e) { log('far-end setup failed:', String(e)); results.notes.push('far-end setup failed: ' + e); }
  }

  let micStream;
  try { micStream = await getMic(micConstraints); }
  catch (e) {
    log(`config ${name}: getUserMedia FAILED:`, String(e));
    results.configs[name] = { error: String(e) };
    return;
  }
  const mset = micStream.getAudioTracks()[0].getSettings();
  log(`mic track settings:`, JSON.stringify({ ec: mset.echoCancellation, ns: mset.noiseSuppression, agc: mset.autoGainControl, label: micStream.getAudioTracks()[0].label }));

  const micTap = tap(ctx, micStream);
  const loopTap = loopbackStream ? tap(ctx, new MediaStream(loopbackStream.getAudioTracks())) : null;

  // tone generator → speakers (audible; this is the "known audio out the speakers")
  const osc = ctx.createOscillator(); osc.frequency.value = TONE_HZ;
  const g = ctx.createGain(); g.gain.value = 0; osc.connect(g); g.connect(ctx.destination); osc.start();
  // Self-monitor: analyser on the generated tone proves it IS being produced, independent of any
  // mic/loopback capture — so we can tell "tone silent" apart from "mic captured nothing".
  const mon = ctx.createAnalyser(); mon.fftSize = 2048; g.connect(mon);
  const monBuf = new Float32Array(mon.fftSize); let monPeak = 0;
  const monTimer = setInterval(() => { mon.getFloatTimeDomainData(monBuf); const r = rms(monBuf); if (r > monPeak) monPeak = r; }, 50);

  const t0 = ctx.currentTime;
  await sleep(1500);                                   // phase SILENCE-A
  const tToneOn = ctx.currentTime;
  g.gain.setValueAtTime(0.25, ctx.currentTime);        // phase TONE (audible burst out speakers)
  await sleep(2500);
  const tToneOff = ctx.currentTime;
  g.gain.setValueAtTime(0, ctx.currentTime);
  await sleep(1200);                                   // phase SILENCE-B
  const tEnd = ctx.currentTime;
  osc.stop(); clearInterval(monTimer);
  log(`  tone self-monitor peak RMS = ${monPeak.toExponential(3)} (proves generator ${monPeak > 1e-3 ? 'ON' : 'SILENT'})`);

  const micPcm = micTap.stop();
  const loopPcm = loopTap ? loopTap.stop() : new Float32Array(0);

  // Measure: mic energy during tone vs during silence = acoustic leakage the AEC should kill.
  const micSil = rmsWindow(micPcm, micTap.marks, t0 + 0.3, tToneOn - 0.1);
  const micTone = rmsWindow(micPcm, micTap.marks, tToneOn + 0.3, tToneOff - 0.1);
  const loopTone = loopTap ? rmsWindow(loopPcm, loopTap.marks, tToneOn + 0.3, tToneOff - 0.1) : { rms: 0 };
  const loopSil = loopTap ? rmsWindow(loopPcm, loopTap.marks, t0 + 0.3, tToneOn - 0.1) : { rms: 0 };

  // Cross-correlation mic↔loopback over the tone window (how much of the played signal is in the mic).
  let xcorr = null;
  if (micTone.n && loopTone.n && loopTap) {
    const a = micPcm.subarray(micTone.lo, micTone.hi);
    const b = loopPcm.subarray(loopTone.lo, Math.min(loopTone.hi, loopTone.lo + a.length));
    const m = Math.min(a.length, b.length);
    if (m > 8000) xcorr = maxXcorr(a.subarray(0, m), b.subarray(0, m), 4800);
  }

  const r = {
    micConstraints, appliedSettings: { ec: mset.echoCancellation, ns: mset.noiseSuppression, agc: mset.autoGainControl },
    toneGeneratorPeakRms: monPeak,
    micRms_silence: micSil.rms, micRms_tone: micTone.rms,
    micRms_silence_db: db(micSil.rms), micRms_tone_db: db(micTone.rms),
    leakage_db: db(micTone.rms) - db(micSil.rms),   // tone-over-floor rise in the mic (lower = better AEC)
    loopbackRms_silence: loopSil.rms, loopbackRms_tone: loopTone.rms,
    loopbackCapturedTone: loopTone.rms > loopSil.rms * 3 && loopTone.rms > 1e-4,
    micLoopXcorr: xcorr,
  };
  results.configs[name] = r;
  log(`  mic RMS  silence=${micSil.rms.toExponential(3)} (${r.micRms_silence_db.toFixed(1)} dB)  tone=${micTone.rms.toExponential(3)} (${r.micRms_tone_db.toFixed(1)} dB)`);
  log(`  => tone-over-floor leakage = ${r.leakage_db.toFixed(1)} dB  (lower = AEC removed more)`);
  log(`  loopback RMS silence=${loopSil.rms.toExponential(3)} tone=${loopTone.rms.toExponential(3)} capturedTone=${r.loopbackCapturedTone}`);
  if (xcorr != null) log(`  mic↔loopback peak xcorr during tone = ${xcorr.toFixed(3)}`);

  await saveWav(`mic_${name}.wav`, micPcm);
  if (loopPcm.length && !results.loopback._wavSaved) { await saveWav('loopback.wav', loopPcm); results.loopback._wavSaved = true; }

  micStream.getTracks().forEach((t) => t.stop());
  if (farEnd) { try { farEnd.pc1.close(); farEnd.pc2.close(); } catch {} }
  await ctx.close();
}

async function main() {
  try {
    log('=== aec-loopback spike ===', new Date().toISOString());

    // 1. Available devices (honesty about headless-audio machines).
    const devs = await navigator.mediaDevices.enumerateDevices();
    results.platform.devices = devs.map((d) => ({ kind: d.kind, label: d.label, deviceId: d.deviceId ? 'set' : '' }));
    const ins = devs.filter((d) => d.kind === 'audioinput');
    const outs = devs.filter((d) => d.kind === 'audiooutput');
    log('audio inputs:', ins.map((d) => d.label || '(unlabeled — mic perm not yet granted)').join(' | ') || '(NONE)');
    log('audio outputs:', outs.map((d) => d.label || '(unlabeled)').join(' | ') || '(NONE)');
    results.platform.hasInput = ins.length > 0;

    // 2. Loopback (system audio) — the headline question.
    const loopback = await getLoopback();

    // 3. Three mic configs.
    await runConfig('A_ec_off', { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, loopback, false);
    await runConfig('B_ec_on', { echoCancellation: true, noiseSuppression: false, autoGainControl: false }, loopback, false);
    await runConfig('C_ec_on_farend', { echoCancellation: true, noiseSuppression: false, autoGainControl: false }, loopback, true);

    if (loopback) loopback.getTracks().forEach((t) => t.stop());

    results.platform.permissions = await ipcRenderer.invoke('perms');

    // Verdict: is a LIVE mic signal actually present? (all-zero across configs => headless/remote audio)
    const micRmsMax = Math.max(0, ...Object.values(results.configs).map((c) => (c && c.micRms_tone) || 0), ...Object.values(results.configs).map((c) => (c && c.micRms_silence) || 0));
    results.summary = {
      loopbackAudioTrack: !!results.loopback.audioTracks,
      micSignalLive: micRmsMax > 1e-4,       // real mic in a quiet room >> this; ~0 => silence
      micRmsMax,
      toneGeneratorWorking: Object.values(results.configs).some((c) => c && c.toneGeneratorPeakRms > 1e-3),
      note: micRmsMax > 1e-4
        ? 'mic delivered live signal — leakage numbers are real'
        : 'mic delivered DIGITAL SILENCE (headless/remote audio and/or mic TCC not granted) — AEC leakage NOT measurable in this run; see permissions',
    };
    log('\nSUMMARY:', JSON.stringify(results.summary));

    await ipcRenderer.invoke('save-json', 'results.json', results);
    log('\n=== RESULTS written to out/results.json ===');
    await ipcRenderer.invoke('done', true);
  } catch (err) {
    log('SPIKE ERROR:', String(err && err.stack || err));
    try { await ipcRenderer.invoke('save-json', 'results.json', { fatalError: String(err && err.stack || err), partial: results }); } catch {}
    await ipcRenderer.invoke('done', false);
  }
}

window.addEventListener('DOMContentLoaded', () => { setTimeout(main, 500); });
