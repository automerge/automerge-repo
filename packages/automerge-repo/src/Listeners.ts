import type { Handle } from "./Handle.js"
import type { Logger } from "./Logger.js"

/** Event listener; payload shape is event-specific. */
type Listener = (payload: any) => void

/**
 * Per-document listener storage: `handle → event → callback → once`. Strong
 * on handles, so any handle with a listener is retained.
 *
 * @internal
 */
export class Listeners {
  readonly #listeners = new Map<
    Handle<any, any, any>,
    Map<string, Map<Listener, boolean>>
  >()

  constructor(private readonly log: Logger) {}

  /** A callback is stored once per event; if added both ways, permanent wins. */
  add(
    handle: Handle<any, any, any>,
    event: string,
    fn: Listener,
    once = false
  ): void {
    let m = this.#listeners.get(handle)
    if (!m) this.#listeners.set(handle, (m = new Map()))
    let s = m.get(event)
    if (!s) m.set(event, (s = new Map()))
    s.set(fn, (s.get(fn) ?? true) && once)
  }

  /** With `fn` undefined, removes every listener for `event`. */
  remove(handle: Handle<any, any, any>, event: string, fn?: Listener): void {
    const m = this.#listeners.get(handle)
    if (!m) return
    if (fn !== undefined) m.get(event)?.delete(fn)
    if (fn === undefined || m.get(event)?.size === 0) m.delete(event)
    if (m.size === 0) this.#listeners.delete(handle)
  }

  removeAll(handle: Handle<any, any, any>): void {
    this.#listeners.delete(handle)
  }

  /** Handles with at least one listener, in registration order. */
  handles(): Handle<any, any, any>[] {
    return [...this.#listeners.keys()]
  }

  listeners(handle: Handle<any, any, any>, event: string): Listener[] {
    return [...(this.#listeners.get(handle)?.get(event)?.keys() ?? [])]
  }

  count(handle: Handle<any, any, any>, event: string): number {
    return this.#listeners.get(handle)?.get(event)?.size ?? 0
  }

  eventNames(handle: Handle<any, any, any>): string[] {
    return [...(this.#listeners.get(handle)?.keys() ?? [])]
  }

  /** @internal Number of handles with at least one listener. */
  get retainedCount(): number {
    return this.#listeners.size
  }

  /**
   * Deliver `event` on `handle` to its listeners, from a snapshot. A
   * `once` callback is removed just before it runs, unless re-added as
   * permanent meanwhile. Swallows per-listener exceptions.
   */
  emit(
    handle: Handle<any, any, any>,
    event: string,
    payload: unknown
  ): boolean {
    const s = this.#listeners.get(handle)?.get(event)
    if (!s?.size) return false
    for (const fn of [...s.keys()]) {
      // Read live: the event's map is replaced if it empties mid-dispatch.
      if (this.#listeners.get(handle)?.get(event)?.get(fn))
        this.remove(handle, event, fn)
      try {
        fn(payload)
      } catch (e) {
        this.log.error("error in handle listener: %o", e)
      }
    }
    return true
  }

  /** Emit `event` on every listening handle; fixed-heads handles are
   * skipped with `writableOnly`. */
  emitAll(
    event: string,
    payload: (handle: Handle<any, any, any>) => unknown,
    { writableOnly = false } = {}
  ): void {
    for (const handle of this.handles()) {
      if (writableOnly && handle.isReadOnly()) continue
      if (this.#listeners.get(handle)?.has(event))
        this.emit(handle, event, payload(handle))
    }
  }
}
