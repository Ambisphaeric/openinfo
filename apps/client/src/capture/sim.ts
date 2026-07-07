import type { CaptureChunk } from '@openinfo/contracts'
import type { EngineLink } from '../engine-link/index.js'

export interface CaptureSimulatorOptions {
  sessionId: string
  workspaceId: string
  cadenceMs: number
  sources?: readonly CaptureChunk['source'][]
}

export class CaptureSimulator {
  readonly emitted: CaptureChunk[] = []
  private running = false
  private loop?: Promise<void>
  private sequence = 1
  private readonly sources: readonly CaptureChunk['source'][]

  constructor(private readonly link: EngineLink, private readonly options: CaptureSimulatorOptions) {
    this.sources = options.sources ?? ['mic', 'screen']
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.loop = this.run()
  }

  async stop(): Promise<void> {
    this.running = false
    await this.loop
  }

  private async run(): Promise<void> {
    while (this.running) {
      const chunk = this.nextChunk()
      this.emitted.push(chunk)
      await this.link.capture(chunk).catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, this.options.cadenceMs))
    }
  }

  private nextChunk(): CaptureChunk {
    const sequence = this.sequence
    this.sequence += 1
    const source = this.sources[(sequence - 1) % this.sources.length] ?? 'mic'
    return {
      id: `sim-${pad(sequence)}`,
      sessionId: this.options.sessionId,
      workspaceId: this.options.workspaceId,
      source,
      sequence,
      capturedAt: new Date().toISOString(),
      contentType: 'text/plain',
      encoding: 'utf8',
      data: `fake ${source} chunk ${sequence}`,
    }
  }
}

const pad = (value: number): string => String(value).padStart(6, '0')
