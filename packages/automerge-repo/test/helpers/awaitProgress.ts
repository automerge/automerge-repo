import type { DocumentProgress } from "../../src/DocumentQuery.js"

/**
 * Resolve once a `findWithProgress` result satisfies `predicate`, driven by the
 * progress object's `subscribe()` callbacks rather than polling `peek()`.
 *
 * Unlike `find()` / `whenReady()`, this tolerates a transient "unavailable"
 * while a peer is still delivering the document: it simply keeps waiting for a
 * later state that satisfies the predicate (e.g. "ready"). Pass `timeout` to
 * bound the wait and reject with a clear error; omit it to fall back on the
 * enclosing test's own timeout.
 */
export async function awaitProgress<T>(
  progress: DocumentProgress<T>,
  predicate: (state: ReturnType<DocumentProgress<T>["peek"]>) => boolean,
  { timeout }: { timeout?: number } = {}
): Promise<void> {
  if (predicate(progress.peek())) return
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let unsubscribe = () => {}
  const finish = (err?: Error) => {
    unsubscribe()
    if (timer != null) clearTimeout(timer)
    if (err) reject(err)
    else resolve()
  }
  unsubscribe = progress.subscribe(state => {
    if (predicate(state)) finish()
  })
  if (timeout != null) {
    timer = setTimeout(
      () => finish(new Error(`awaitProgress timed out after ${timeout}ms`)),
      timeout
    )
  }
  await promise
}
