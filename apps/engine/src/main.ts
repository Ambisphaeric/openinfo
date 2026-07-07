// Phase 0 stub engine: serves contracts + flags to curl. Zero framework by design.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AllSchemas, Routes } from '@openinfo/contracts'

const here = dirname(fileURLToPath(import.meta.url))
const examplesDir = join(here, '..', '..', '..', 'shared', 'contracts', 'examples')
const flags: unknown[] = JSON.parse(readFileSync(join(examplesDir, 'flag.examples.json'), 'utf8'))

const json = (body: unknown, status = 200) =>
  ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body, null, 2) })

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const route = (() => {
    if (url.pathname === '/health') return json({ ok: true, phase: 0 })
    if (url.pathname === '/contracts') return json(Object.keys(AllSchemas))
    if (url.pathname === '/routes') return json(Routes)
    if (url.pathname === '/flags') return json(flags)
    const m = url.pathname.match(/^\/contracts\/([A-Za-z]+)$/)
    if (m && m[1]! in AllSchemas) return json(AllSchemas[m[1] as keyof typeof AllSchemas])
    return json({ error: `no such route: ${url.pathname}` }, 404)
  })()
  res.writeHead(route.status, route.headers)
  res.end(route.body)
})

const port = Number(process.env['OPENINFO_PORT'] ?? 8787)
server.listen(port, () => console.log(`openinfo engine (phase 0 stub) on :${port}`))
