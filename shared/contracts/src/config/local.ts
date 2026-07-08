import { Type, type Static } from '@sinclair/typebox'
import { CapabilitySlot } from './discovery.js'
import { LocalRuntime } from './fabric.js'

/**
 * Tier-zero starter models (ARCHITECTURE §8 onboarding note, slice c). The true first run has NO model
 * server at all; the designed home is the `local` endpoint kind (§8) — the engine spawns a managed
 * runtime (v0: llama.cpp's llama-server for llm, whisper.cpp's whisper-server for stt) and fills a slot
 * with a `local` endpoint. Before it can spawn, a model file must exist on disk. A seeded, versioned
 * DOCUMENT (everything user-configurable is a document) lists a few vetted small models per slot with
 * exact download URLs, filenames, and honest sizes. Never auto-downloaded — a starter model is fetched
 * only on an explicit user click.
 */

/**
 * One vetted starter model: which slot it fills, which runtime runs it, its download URL + on-disk
 * filename, and an honest approximate size. `sizeBytes` is for the UI ("~1.1 GB"); the real integrity
 * check at download time is the server's Content-Length (exact) plus a truncation floor — `sha256` is
 * optional and, when present, verified.
 */
export const StarterModel = Type.Object(
  {
    id: Type.String({ minLength: 1, description: 'stable id; the local endpoint references it as its `model`' }),
    slot: CapabilitySlot,
    runtime: LocalRuntime,
    name: Type.String({ minLength: 1, description: 'human label shown in the Get-Started lens' }),
    filename: Type.String({ minLength: 1, description: 'on-disk filename under the data root models/ dir' }),
    url: Type.String({ pattern: '^https://', description: 'a direct download URL (e.g. a Hugging Face resolve link)' }),
    sizeBytes: Type.Integer({ minimum: 1, description: 'approximate download size, stated honestly in the UI' }),
    sha256: Type.Optional(Type.String({ description: 'optional integrity hash; verified after download when present' })),
    description: Type.Optional(Type.String()),
  },
  { $id: 'StarterModel', additionalProperties: false },
)
export type StarterModel = Static<typeof StarterModel>

/**
 * The starter-models DOCUMENT — a versioned list of `StarterModel`s, seeded when absent (like the probe
 * list / capability map), stored in _meta.db, editable as a document. Discovery's "no server at all"
 * branch offers these when nothing was found; a click downloads one into the data root and writes a
 * `local` endpoint into config-1.
 */
export const StarterModels = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    version: Type.Integer({ minimum: 1, description: 'store-stamped, monotonic; every prior version is kept' }),
    models: Type.Array(StarterModel),
    description: Type.Optional(Type.String()),
  },
  { $id: 'StarterModels', additionalProperties: false },
)
export type StarterModels = Static<typeof StarterModels>
