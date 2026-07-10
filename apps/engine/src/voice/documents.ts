import type { Register, VoiceBinding } from '@openinfo/contracts'
import type { WorkspaceRegistry } from '../store/index.js'
import { builtinRegisters } from './defaults.js'

const REGISTER_KIND = 'register'
const BINDING_KIND = 'voice-binding'
const REGISTER_INDEX = 'ids'
const BINDING_INDEX = 'keys'

const bindingKey = (b: VoiceBinding): string => `${b.scope}:${b.targetId ?? '*'}`

/**
 * Store-backed voice documents (registers + bindings), consistent with FabricDocuments/flags:
 * they live as versioned config docs in _meta.db. A small index doc under each kind records the
 * live keys so listing does not need a store-layer schema change. Resolution itself is pure and
 * lives in resolve.ts — this class only loads/persists.
 */
export class VoiceDocuments {
  constructor(private readonly store: WorkspaceRegistry) {}

  ensureDefaults(): void {
    const ids = this.store.layouts.getLatest<string[]>(REGISTER_KIND, REGISTER_INDEX)?.body
    if (ids) return
    for (const register of builtinRegisters) this.store.layouts.put(REGISTER_KIND, register.id, register)
    this.store.layouts.put(REGISTER_KIND, REGISTER_INDEX, builtinRegisters.map((r) => r.id))
  }

  registers(): Register[] {
    const ids = this.store.layouts.getLatest<string[]>(REGISTER_KIND, REGISTER_INDEX)?.body ?? []
    return ids
      .map((id) => this.store.layouts.getLatest<Register>(REGISTER_KIND, id)?.body)
      .filter((r): r is Register => r !== undefined)
  }

  /**
   * The stored register for an id, falling back to a shipped builtin of that id, else undefined — the GET
   * /registers/:id read (unknown ⇒ 404), symmetric with DistillDocuments.templateById/modeById. The
   * write half (saveRegister) already existed; #23 exposes it over PUT /registers/:id.
   */
  registerById(id: string): Register | undefined {
    return this.store.layouts.getLatest<Register>(REGISTER_KIND, id)?.body ?? builtinRegisters.find((r) => r.id === id)
  }

  saveRegister(register: Register): Register {
    this.store.layouts.put(REGISTER_KIND, register.id, register)
    const ids = this.store.layouts.getLatest<string[]>(REGISTER_KIND, REGISTER_INDEX)?.body ?? []
    if (!ids.includes(register.id)) this.store.layouts.put(REGISTER_KIND, REGISTER_INDEX, [...ids, register.id])
    return register
  }

  bindings(): VoiceBinding[] {
    const keys = this.store.layouts.getLatest<string[]>(BINDING_KIND, BINDING_INDEX)?.body ?? []
    return keys
      .map((key) => this.store.layouts.getLatest<VoiceBinding>(BINDING_KIND, key)?.body)
      .filter((b): b is VoiceBinding => b !== undefined)
  }

  saveBinding(binding: VoiceBinding): VoiceBinding {
    const key = bindingKey(binding)
    this.store.layouts.put(BINDING_KIND, key, binding)
    const keys = this.store.layouts.getLatest<string[]>(BINDING_KIND, BINDING_INDEX)?.body ?? []
    if (!keys.includes(key)) this.store.layouts.put(BINDING_KIND, BINDING_INDEX, [...keys, key])
    return binding
  }
}
