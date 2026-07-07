import { createEngineApp } from './api/http.js'

export { createEngineApp } from './api/http.js'

const isEntry = process.argv[1]?.endsWith('/main.js') ?? false

if (isEntry) {
  const app = createEngineApp()
  const port = Number(process.env['OPENINFO_PORT'] ?? 8787)
  app.server.listen(port, () => console.log(`openinfo engine (phase 1 seam) on :${port}`))
}
