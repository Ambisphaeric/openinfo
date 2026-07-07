import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CaptureChunk } from '@openinfo/contracts'

const pad = (value: number): string => String(value).padStart(12, '0')

export class OfflineSpool {
  private nextSerial = 1
  private ready = false

  constructor(private readonly dir: string) {}

  async enqueue(chunk: CaptureChunk): Promise<void> {
    await this.init()
    const file = join(this.dir, `${pad(this.nextSerial)}-${chunk.id}.json`)
    this.nextSerial += 1
    await writeFile(file, JSON.stringify(chunk), 'utf8')
  }

  async pendingCount(): Promise<number> {
    await this.init()
    return (await this.files()).length
  }

  async flush(send: (chunk: CaptureChunk) => Promise<void>): Promise<number> {
    await this.init()
    let sent = 0
    for (const file of await this.files()) {
      const path = join(this.dir, file)
      const chunk = JSON.parse(await readFile(path, 'utf8')) as CaptureChunk
      await send(chunk)
      await rm(path, { force: true })
      sent += 1
    }
    return sent
  }

  private async init(): Promise<void> {
    if (this.ready) return
    await mkdir(this.dir, { recursive: true })
    const serials = (await this.files()).map((file) => Number(file.slice(0, 12))).filter(Number.isFinite)
    this.nextSerial = (serials.length === 0 ? 0 : Math.max(...serials)) + 1
    this.ready = true
  }

  private async files(): Promise<string[]> {
    return (await readdir(this.dir)).filter((file) => file.endsWith('.json')).sort()
  }
}
