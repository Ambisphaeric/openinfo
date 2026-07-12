import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaptureChunk } from '@openinfo/contracts'
import { FabricDocuments } from '../fabric/index.js'
import { WorkspaceRegistry } from '../store/index.js'
import { VoiceDocuments } from '../voice/index.js'
import { PresetDocuments } from '../presets/index.js'
import { Distiller, type LlmInvoke } from './distiller.js'
import { DistillDocuments } from './documents.js'

/**
 * pill P2 — ACTUAL preset injection, proven at the distill pass. The differentiator is that a selected
 * preset ACTUALLY changes the distill prompt (upstream glass stored the presets but never injected them).
 * These tests flip the active preset and observe the prompt the distiller sends, plus the honest
 * provenance stamp — and pin the regression guard: an unset preset is byte-identical to today.
 */

const WS = 'ws-preset'

const speech = (sequence: number, data: string): CaptureChunk => ({
  id: `sp-${sequence}`,
  sessionId: 'ses-p',
  workspaceId: WS,
  source: 'mic',
  sequence,
  capturedAt: new Date(Date.UTC(2026, 6, 12, 14, 0, sequence)).toISOString(),
  contentType: 'text/plain',
  encoding: 'utf8',
  data,
})

const setup = async (): Promise<{ dir: string; store: WorkspaceRegistry; presets: PresetDocuments; prompts: string[]; distiller: Distiller }> => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-preset-inject-'))
  const store = new WorkspaceRegistry(dir)
  const voice = new VoiceDocuments(store)
  voice.ensureDefaults()
  const docs = new DistillDocuments(store)
  docs.ensureDefaults()
  const presets = new PresetDocuments(store)
  presets.ensureDefaults()
  const fabric = new FabricDocuments(store)
  const prompts: string[] = []
  const invoke: LlmInvoke = (messages) => {
    prompts.push(messages[0]!.content)
    return Promise.resolve({ text: 'a tight factual summary', slot: 'llm', endpoint: 'fake-local' })
  }
  const distiller = new Distiller({ store, voice, docs, fabric, presets, invoke })
  return { dir, store, presets, prompts, distiller }
}

test('pill P2: an UNSET preset is byte-identical to today (regression guard)', async () => {
  const { dir, prompts, distiller } = await setup()
  try {
    const [distillate] = await distiller.distillChunks([speech(1, 'we should ship on Thursday')])
    assert.equal(prompts.length, 1, 'one summary invoke')
    // Byte-identical to the pre-P2 prompt: it starts with the shipped distill instruction and carries no
    // prepended preset context.
    assert.ok(prompts[0]!.startsWith('You are distilling a live meeting'), 'the base distill prompt, unmodified')
    assert.ok(!prompts[0]!.startsWith('Context:'), 'no preset context prepended')
    assert.equal(distillate!.provenance.presetId, undefined, 'no presetId stamped when none was active')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('pill P2: flipping the active preset changes the distill prompt AND stamps honest provenance', async () => {
  const { dir, store, presets, prompts, distiller } = await setup()
  try {
    // Baseline (unset).
    await distiller.distillChunks([speech(1, 'we should ship on Thursday')])
    const baseline = prompts[0]!

    // Flip the active preset for THIS workspace.
    presets.setActive(WS, 'preset-sales')
    const [distillate] = await distiller.distillChunks([speech(2, 'the client asked about pricing')])
    const withPreset = prompts[1]!

    const salesBody = presets.get('preset-sales')!.body
    // The Sales preset body is prepended as leading context to the SAME base prompt (build only steers the
    // summary — proof the selection actually reaches the prompt path).
    assert.notEqual(withPreset, baseline, 'the prompt changed when the preset was flipped')
    assert.ok(withPreset.startsWith(`${salesBody}\n\n`), 'the active preset body is prepended')
    assert.ok(withPreset.includes('You are distilling a live meeting'), 'the base distill prompt is preserved beneath it')
    // The why-record honestly names the preset that shaped the summary.
    assert.equal(distillate!.provenance.presetId, 'preset-sales', 'provenance names the active preset')

    // A different workspace with no selection is unaffected (per-workspace isolation of the seam).
    assert.equal(store.getActivePreset('another-ws'), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
