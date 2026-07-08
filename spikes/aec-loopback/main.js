// THROWAWAY SPIKE — aec-loopback. Not production code; hardcode freely; never imported.
// Question: on darwin 25 / Electron 38, can we capture SYSTEM AUDIO via loopback, and does
// built-in echoCancellation (or the AEC3 far-end trick) remove speaker leakage from the mic?
//
// Main process: grants a display-media request with audio:'loopback' (the whole point), prints
// desktopCapturer sources, and writes whatever the renderer hands it into ./out/.

const { app, BrowserWindow, desktopCapturer, session, ipcMain, systemPreferences } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'out');
const KEEP_OPEN = process.env.KEEP_OPEN === '1';

function log(...a) { console.log('[main]', ...a); }

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // Report + request TCC status up front (mic capture and speaker->mic acoustics need it).
  const perms = { micStatus: null, screenStatus: null, askResult: null };
  try {
    perms.micStatus = systemPreferences.getMediaAccessStatus('microphone');
    perms.screenStatus = systemPreferences.getMediaAccessStatus('screen');
    log('mic access status:', perms.micStatus, '| screen access status:', perms.screenStatus);
    perms.askResult = await systemPreferences.askForMediaAccess('microphone');
    log('askForMediaAccess(microphone) ->', perms.askResult);
  } catch (e) { log('media-access probe error:', e && e.message); perms.error = String(e); }
  ipcMain.handle('perms', () => perms);

  // --- The half-the-value line: try to grant loopback system audio on macOS. ---
  // Electron docs say string 'loopback' is "Windows only"; we grant it anyway and let the
  // renderer report whether an audio track actually materialises on this macOS/Electron.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    log('display-media request:', JSON.stringify({
      audioRequested: request.audioRequested, videoRequested: request.videoRequested,
    }));
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      if (!sources.length) { log('desktopCapturer: no screen sources (Screen Recording denied?)'); callback({}); return; }
      log('desktopCapturer screen sources:', sources.map((s) => s.name).join(' | '));
      callback({ video: sources[0], audio: 'loopback' });
    }).catch((err) => {
      // Screen Recording TCC denied -> getSources throws here; report, don't crash.
      log('desktopCapturer.getSources failed (Screen Recording TCC?):', (err && err.message) || err);
      callback({}); // deny — renderer reports the failure cleanly
    });
  });

  // Window MUST be visible + focused + unthrottled: Chromium suspends the AudioContext render
  // and MediaStream capture of a hidden/backgrounded window (first run gave digital-silence mic).
  const win = new BrowserWindow({
    width: 640, height: 480, show: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
  });
  win.show(); win.focus();
  // Route renderer console to the terminal so a headless run is legible.
  win.webContents.on('console-message', (_e, _level, message) => console.log('[renderer]', message));

  ipcMain.handle('save', (_e, name, b64) => {
    const p = path.join(OUT, name);
    fs.writeFileSync(p, Buffer.from(b64, 'base64'));
    log('wrote', p, `(${(fs.statSync(p).size / 1024).toFixed(1)} KiB)`);
    return p;
  });
  ipcMain.handle('save-json', (_e, name, obj) => {
    const p = path.join(OUT, name);
    fs.writeFileSync(p, JSON.stringify(obj, null, 2));
    log('wrote', p);
    return p;
  });
  ipcMain.handle('done', (_e, ok) => {
    log(ok ? 'renderer reported DONE' : 'renderer reported FAILURE');
    if (!KEEP_OPEN) { setTimeout(() => app.quit(), 300); }
  });

  await win.loadFile('index.html');
  log('window loaded; KEEP_OPEN =', KEEP_OPEN);
});

app.on('window-all-closed', () => app.quit());
