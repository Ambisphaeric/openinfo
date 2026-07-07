/*
 * Adapted from loom packages/bus
 * (~/Apps/Monorepo/loom/packages/bus, read 2026-07-07).
 * The original depends on loom-only flow-control/session/resilience packages, so Phase 1 keeps
 * the same pub/sub shape as a minimal typed equivalent for openinfo events.
 */
export type EventHandler<T> = (payload: T) => void | Promise<void>

export class EventBus<Events extends object> {
  private readonly handlers = new Map<string, Set<EventHandler<unknown>>>()

  subscribe<Name extends keyof Events & string>(name: Name | '*', handler: EventHandler<Events[Name]>): () => void {
    const bucket = this.handlers.get(name) ?? new Set<EventHandler<unknown>>()
    bucket.add(handler as EventHandler<unknown>)
    this.handlers.set(name, bucket)
    return () => bucket.delete(handler as EventHandler<unknown>)
  }

  async publish<Name extends keyof Events & string>(name: Name, payload: Events[Name]): Promise<void> {
    const exact = [...(this.handlers.get(name) ?? [])]
    const wildcard = [...(this.handlers.get('*') ?? [])]
    await Promise.all([...exact, ...wildcard].map((handler) => handler(payload)))
  }

  listenerCount(name?: keyof Events & string): number {
    if (name) return this.handlers.get(name)?.size ?? 0
    return [...this.handlers.values()].reduce((count, bucket) => count + bucket.size, 0)
  }
}
