import type { Endpoint, Fabric } from '@openinfo/contracts'

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LlmResult {
  text: string
  endpoint: string
  model?: string
  slot: 'llm'
}

export interface InvokeOptions {
  timeoutMs?: number
  maxTokens?: number
  temperature?: number
}

interface ChatCompletion {
  choices?: { message?: { content?: string } }[]
}

/**
 * Call one http llm endpoint speaking the OpenAI-compatible chat-completions shape
 * (mlx / LM Studio style local servers). Throws on transport or protocol failure so the caller
 * can fall through to the next endpoint in fabric order.
 */
const callHttp = async (endpoint: Extract<Endpoint, { kind: 'http' }>, messages: LlmMessage[], opts: InvokeOptions): Promise<string> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000)
  try {
    const body: Record<string, unknown> = { messages, stream: false }
    if (endpoint.model !== undefined) body['model'] = endpoint.model
    if (opts.maxTokens !== undefined) body['max_tokens'] = opts.maxTokens
    if (opts.temperature !== undefined) body['temperature'] = opts.temperature
    const response = await fetch(`${endpoint.url.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const json = (await response.json()) as ChatCompletion
    const text = json.choices?.[0]?.message?.content
    if (typeof text !== 'string') throw new Error('no completion content in response')
    return text
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Invoke the `llm` slot: try endpoints in fabric order (order is fallback, first that answers
 * wins). http/openai-compat endpoints are called; local is a stub (skipped) and cloud is out of
 * scope for this slice — offline local runtimes land with managed runtimes later.
 */
export const invokeLlm = async (
  fabric: Fabric,
  messages: LlmMessage[],
  opts: InvokeOptions = {},
): Promise<LlmResult> => {
  const endpoints = fabric.slots.llm
  const failures: string[] = []
  for (const endpoint of endpoints) {
    if (endpoint.kind === 'local') {
      failures.push(`${endpoint.name}: local runtime invocation is stubbed`)
      continue
    }
    if (endpoint.kind === 'cloud') {
      failures.push(`${endpoint.name}: cloud endpoints are out of scope`)
      continue
    }
    if (endpoint.api !== 'openai-compat') {
      failures.push(`${endpoint.name}: unsupported api "${endpoint.api}"`)
      continue
    }
    try {
      const text = await callHttp(endpoint, messages, opts)
      const result: LlmResult = { text, endpoint: endpoint.name, slot: 'llm' }
      if (endpoint.model !== undefined) result.model = endpoint.model
      return result
    } catch (error) {
      failures.push(`${endpoint.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`no llm endpoint answered${failures.length ? ` (${failures.join('; ')})` : ' (fabric llm slot is empty)'}`)
}
