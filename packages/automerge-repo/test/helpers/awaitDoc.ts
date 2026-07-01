import type { DocHandle } from "../../src/DocHandle.js"
import { awaitEvent } from "./awaitEvent.js"

/**
 * Resolve once the handle's document satisfies `predicate`, driven by the
 * handle's `heads-changed` event rather than a fixed sleep. Returns immediately
 * if the predicate already holds. Pass `timeout` to bound the wait and reject
 * with a clear error if it never holds; omit it to fall back on the enclosing
 * test's own timeout.
 */
export async function awaitDoc<T>(
  handle: DocHandle<T>,
  predicate: (handle: DocHandle<T>) => boolean,
  { timeout }: { timeout?: number } = {}
): Promise<void> {
  if (predicate(handle)) return
  await awaitEvent(handle, "heads-changed", () => predicate(handle), {
    timeout,
  })
}
