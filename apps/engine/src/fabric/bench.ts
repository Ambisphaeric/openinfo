import type { Endpoint, Fabric } from '@openinfo/contracts'
import { checkEndpoint } from './health.js'

const withMeasured = (endpoint: Endpoint, latencyMs: number): Endpoint => {
  const measured = { ...endpoint.measured, latencyMs, measuredAt: new Date().toISOString() }
  if (endpoint.kind === 'http') return { ...endpoint, measured }
  if (endpoint.kind === 'local') return { ...endpoint, measured }
  return { ...endpoint, measured }
}

export const benchHttpEndpoint = async (endpoint: Endpoint, timeoutMs = 1_000): Promise<Endpoint> => {
  if (endpoint.kind !== 'http') return endpoint
  const health = await checkEndpoint(endpoint, timeoutMs)
  return withMeasured(endpoint, health.latencyMs ?? timeoutMs)
}

export const benchFabric = async (fabric: Fabric, timeoutMs = 1_000): Promise<Fabric> => ({
  ...fabric,
  slots: {
    stt: await Promise.all(fabric.slots.stt.map((endpoint) => benchHttpEndpoint(endpoint, timeoutMs))),
    tts: await Promise.all(fabric.slots.tts.map((endpoint) => benchHttpEndpoint(endpoint, timeoutMs))),
    llm: await Promise.all(fabric.slots.llm.map((endpoint) => benchHttpEndpoint(endpoint, timeoutMs))),
    vlm: await Promise.all(fabric.slots.vlm.map((endpoint) => benchHttpEndpoint(endpoint, timeoutMs))),
    ocr: await Promise.all(fabric.slots.ocr.map((endpoint) => benchHttpEndpoint(endpoint, timeoutMs))),
    embed: await Promise.all(fabric.slots.embed.map((endpoint) => benchHttpEndpoint(endpoint, timeoutMs))),
  },
})
