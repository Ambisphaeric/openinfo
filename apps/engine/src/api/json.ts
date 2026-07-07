import type { ServerResponse } from 'node:http'

export interface JsonResult {
  status: number
  body: unknown
}

export const ok = (body: unknown): JsonResult => ({ status: 200, body })
export const created = (body: unknown): JsonResult => ({ status: 201, body })
export const badRequest = (message: string, details: string[] = []): JsonResult => ({
  status: 400,
  body: { error: message, details },
})
export const notFound = (path: string): JsonResult => ({ status: 404, body: { error: `no such route: ${path}` } })

export const sendJson = (res: ServerResponse, result: JsonResult): void => {
  res.writeHead(result.status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(result.body, null, 2))
}
