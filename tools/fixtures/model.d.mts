export type FixtureLane = 'mic' | 'system-audio' | 'screen'

export interface FixtureCaptureChunk {
  id: string
  sessionId: string
  workspaceId: string
  source: FixtureLane
  sequence: number
  capturedAt: string
  contentType: string
  encoding: 'utf8' | 'base64'
  data: string
}

export interface FixtureScreenResult {
  text: string
  blocks?: { text: string; confidence?: number; region?: { x: number; y: number; width: number; height: number } }[]
  endpoint: string
  model?: string
  slot: 'ocr' | 'vlm'
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number; estimated: boolean; durationMs?: number }
  egress?: {
    reach: 'local' | 'egress'
    allowed: boolean
    decidedBy: 'endpoint' | 'prompt' | 'mode' | 'workspace' | 'content-class' | 'default'
    reason: string
  }
}

export interface FixtureReplay {
  fixtureId: string
  entries(): unknown[]
  captures(lane?: FixtureLane): FixtureCaptureChunk[]
  invokeStt(audio: { base64: string; contentType: string }): Promise<unknown>
  invokeSttFor(captureId: string, audio: { base64: string; contentType: string }): Promise<unknown>
  invokeOcr(params: { image: string; contentType: string }): Promise<FixtureScreenResult>
  invokeOcrFor(captureId: string, params: { image: string; contentType: string }): Promise<FixtureScreenResult>
  invokeVlm(params: { image: string; contentType: string; prompt?: string }): Promise<FixtureScreenResult>
  invokeVlmFor(captureId: string, params: { image: string; contentType: string; prompt?: string }): Promise<FixtureScreenResult>
  now(): Date
  newId(): string
  reset(): void
}

export class FixtureError extends Error {}
export function canonicalize(value: unknown): unknown
export function canonicalJson(value: unknown): string
export function canonicalStringify(value: unknown): string
export function computeFixtureDigest(value: unknown): string
export function fixtureIdForDigest(digest: string): string
export function validateFixture<T>(value: T, source?: string): T
export function parseFixture(text: string, source?: string): unknown
export function loadFixtureSync(path: string | URL): unknown
export function recordFixture(entries: unknown[], options: {
  classification: 'synthetic' | 'sanitized' | 'sensitive'
  allowRawMedia?: boolean
  containsPersonalData?: boolean
  recordedAt?: string
  replayAt?: string
}): unknown
export function createFixtureReplay(value: unknown): FixtureReplay
export function replayFixture(value: unknown, onEntry: (entry: unknown) => void): void
export function fixtureSummary(value: unknown): unknown
