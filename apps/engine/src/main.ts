import { createEngineApp } from './api/http.js'
import { wireScreenOcr } from './screen/index.js'

export { createEngineApp } from './api/http.js'

const isEntry = process.argv[1]?.endsWith('/main.js') ?? false

if (isEntry) {
  const app = createEngineApp()
  // Screen understanding (P4B): the screen-OCR processor rides capture ingest, gated on `screen.ocr`.
  // Wired here (not inside createEngineApp) so it stays out of the P4A-owned http.ts; tests wire the
  // same way explicitly. The /screen router is mounted inside http.ts and reads this processor's status.
  wireScreenOcr(app, { log: console.log })
  const port = Number(process.env['OPENINFO_PORT'] ?? 8787)
  app.server.listen(port, () => console.log(`openinfo engine (phase 1 seam) on :${port}`))
}
