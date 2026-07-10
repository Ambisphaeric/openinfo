/**
 * THROWAWAY SPIKE (#142) — does Electron 38's macOS loopback path expose a system-audio track?
 *
 * The PHASE2 aec-loopback spike (Electron 38.8.6) concluded string-form `audio:'loopback'` yields NO
 * macOS system-audio track — but that run had Screen-Recording TCC DENIED and NO NSAudioCaptureUsageDescription
 * Info.plist key, which per Electron's own docs produces a "dead audio stream without warnings". Meanwhile
 * Chromium gained a CoreAudio-Tap path (feature `MacCatapLoopbackAudioForScreenShare`) that became the
 * DEFAULT in Electron v39; on v38 it exists but is opt-in. This spike isolates the API-surface question
 * from the TCC/plist question: with the fake-UI auto-grant, does `setDisplayMediaRequestHandler` +
 * `getDisplayMedia({audio:true})` actually hand back an AUDIO track on this Electron 38 build?
 *
 * It does NOT prove live capture (that needs a granted TCC + real playing audio + the plist key, i.e. a
 * packaged app + a human) — it answers the code-shaped question that decides the product default.
 *
 * Run: cd spikes/sysaudio-loopback && npx electron main.mjs   (needs a GUI session on macOS)
 */
import { app, BrowserWindow, desktopCapturer, session } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Opt into Chromium's CoreAudio Tap on macOS 14.2+ (default only from Electron v39; explicit on v38).
app.commandLine.appendSwitch('enable-features', 'MacCatapLoopbackAudioForScreenShare')
// Auto-grant the media request so no human click is needed for the API-surface probe.
app.commandLine.appendSwitch('use-fake-ui-for-media-stream')

const out = (obj) => console.log('SPIKE_RESULT ' + JSON.stringify(obj))

app.whenReady().then(async () => {
  let handlerSawAudioRequested = null
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      handlerSawAudioRequested = request.audioRequested
      out({ phase: 'handler-invoked', audioRequested: request.audioRequested, videoRequested: request.videoRequested })
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => {
          out({ phase: 'getSources-ok', count: sources.length })
          callback({ video: sources[0], audio: 'loopback' })
        })
        .catch((err) => {
          out({ phase: 'getSources', error: String(err) })
          callback({})
        })
    },
    { useSystemPicker: false },
  )

  const win = new BrowserWindow({ show: false })
  await win.loadFile(path.join(__dirname, 'probe.html'))

  const result = await win.webContents.executeJavaScript(`
    (async () => {
      try {
        const gdm = navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
        const stream = await Promise.race([
          gdm,
          new Promise((_, rej) => setTimeout(() => rej(new Error('gdm-timeout-8s')), 8000)),
        ])
        const audio = stream.getAudioTracks()
        const video = stream.getVideoTracks()
        const summary = {
          gotStream: true,
          audioTracks: audio.length,
          videoTracks: video.length,
          audioLabel: audio[0] ? audio[0].label : null,
          audioSettings: audio[0] ? audio[0].getSettings() : null,
        }
        stream.getTracks().forEach((t) => t.stop())
        return summary
      } catch (err) {
        return { gotStream: false, error: (err && err.name) + ': ' + (err && err.message) }
      }
    })()
  `)

  out({ phase: 'getDisplayMedia', handlerSawAudioRequested, ...result })
  app.exit(0)
})

setTimeout(() => {
  out({ phase: 'timeout', note: 'no result in 20s' })
  app.exit(2)
}, 20000)
