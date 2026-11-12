import type { DocHandle } from "./DocHandle.js"
import type { Logger } from "./Logger.js"

/** Event listener; payload shape is event-specific. */
type Listener = (payload: any) => void

/**
 * Per-document listener storage: `handle → event → callbacks`. Strong on
 * handles, so any handle with a listener is retained.
 *
 * @internal
 */
export class Listeners {
  readonly #listeners = new Map<DocHandle<any>, Map<string, Set<Listener>>>()

  constructor(private readonly log: Logger) {}

  add(handle: DocHandle<any>, event: string, fn: Listener): void {
    let m = this.#listeners.get(handle)
    if (!m) this.#listeners.set(handle, (m = new Map()))
    let s = m.get(event)
    if (!s) m.set(event, (s = new Set()))
    s.add(fn)
  }

  /** Without `fn`, removes every listener for `event`. */
  remove(handle: DocHandle<any>, event: string, fn?: Listener): void {
    const m = this.#listeners.get(handle)
    if (!m) return
    if (fn) m.get(event)?.delete(fn)
    if (!fn || m.get(event)?.size === 0) m.delete(event)
    if (m.size === 0) this.#listeners.delete(handle)
  }

  removeAll(handle: DocHandle<any>): void {
    this.#listeners.delete(handle)
  }

  /** Handles with at least one listener, in registration order. */
  handles(): DocHandle<any>[] {
    return [...this.#listeners.keys()]
  }

  listeners(handle: DocHandle<any>, event: string): Listener[] {
    return [...(this.#listeners.get(handle)?.get(event) ?? [])]
  }

  count(handle: DocHandle<any>, event: string): number {
    return this.#listeners.get(handle)?.get(event)?.size ?? 0
  }

  eventNames(handle: DocHandle<any>): string[] {
    return [...(this.#listeners.get(handle)?.keys() ?? [])]
  }

  /** Whether any writable handle listens for `event`. */
  hasWritable(event: string): boolean {
    for (const [handle, events] of this.#listeners)
      if (!handle.isReadOnly() && events.has(event)) return true
    return false
  }

  /** @internal Number of handles with at least one listener. */
  get retainedCount(): number {
    return this.#listeners.size
  }

  /**
   * Deliver `event` on `handle` to its listeners. Snapshots the set so
   * once-handlers can self-remove without perturbing the loop. Swallows
   * per-listener exceptions.
   */
  emit(handle: DocHandle<any>, event: string, payload: unknown): boolean {
    const s = this.#listeners.get(handle)?.get(event)
    if (!s?.size) return false
    for (const fn of [...s]) {
      try {
        fn(payload)
      } catch (e) {
        try {
          this.log.error("error in handle listener: %o", e)
        } catch {
          // Application logging must not prevent remaining listeners from running.
        }
      }
    }
    return true
  }

  /** Emit `event` on every listening handle; fixed-heads handles are
   * skipped with `writableOnly`. */
  emitAll(
    event: string,
    payload: (handle: DocHandle<any>) => unknown,
    { writableOnly = false } = {}
  ): void {
    for (const handle of this.handles()) {
      if (writableOnly && handle.isReadOnly()) continue
      if (this.#listeners.get(handle)?.has(event))
        this.emit(handle, event, payload(handle))
    }
  }
}
