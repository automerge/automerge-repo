/**
 * A counting semaphore that caps how many of the functions passed to it run at
 * once. Returns a gate, `limit`, that you wrap each call in; at most
 * `concurrency` run concurrently and the rest queue (FIFO), starting as slots
 * free up.
 *
 * @remarks
 * This is the fix for the most common async pitfall: `Promise.all(items.map(fn))`
 * launches *every* task at once (promises are eager), overwhelming a bounded
 * resource such as a connection pool, an HTTP host's connection cap, a
 * file-descriptor limit, an API rate limit, or just memory. Gate each call so
 * at most `concurrency` run concurrently:
 *
 * ```typescript
 * const limit = semaphore(10)
 * const results = await Promise.all(items.map(item => limit(() => work(item))))
 * ```
 *
 * `Promise.all` still resolves results in input order, and its rejection
 * semantics are unchanged; the gate only throttles *when* each function is
 * invoked. A slot is released in `finally`, so a rejecting task does not stall
 * the queue. Note this is the "run a function under the gate" shape
 * (`limit(() => fn())`), not a classic `acquire()` / `release()` semaphore.
 *
 * **Choosing `concurrency`**: tie it to the constraining resource, not a vibe.
 * - filesystem: stay well under the process's file-descriptor ceiling
 * - HTTP/1.1-backed: a browser allows ~6 connections per origin
 * - HTTP/2-backed: ~100 multiplexed streams per connection
 * - database-backed: at or below the connection-pool size, with headroom for
 *   other callers
 *
 * **Synchronous-start contract**: when a slot is free, `fn` is invoked
 * *synchronously* in the current tick (like a bare `items.map(fn)`), not
 * deferred to a microtask. Callers that start work and then synchronously act
 * on it (for example, unblocking a paused test double immediately after kicking
 * the work off) rely on this. Do not refactor the call to `fn` behind a
 * `.then()` / `queueMicrotask` (or an `await` before `fn()` is reached on the
 * free-slot path).
 *
 * @param concurrency - Maximum number of wrapped functions allowed to run at
 *   once. Must be a positive integer.
 * @returns A `limit(fn)` gate. Each call runs `fn` when a slot is free and
 *   resolves/rejects with `fn`'s result.
 */
export function semaphore(concurrency: number): Limit {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError("semaphore: concurrency must be a positive integer")
  }

  let active = 0
  const waiters: Array<() => void> = []

  const release = () => {
    // Hand the slot straight to the next waiter (active unchanged) so a caller
    // arriving in the same tick can't slip in front of it; only free the slot
    // when nobody is waiting.
    const wake = waiters.shift()
    if (wake) wake()
    else active--
  }

  return async <T>(fn: () => PromiseLike<T> | T): Promise<T> => {
    if (active < concurrency) {
      active++
    } else {
      // At capacity: park until release() hands us a slot.
      const { promise, resolve } = Promise.withResolvers<void>()
      waiters.push(resolve)
      await promise
    }
    // The free-slot path reaches here with no intervening await, so `fn()` runs
    // synchronously in the current tick (the synchronous-start contract).
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

/** The gate returned by {@link semaphore}: runs `fn` under the concurrency
 * limit and resolves/rejects with its result. */
export type Limit = <T>(fn: () => PromiseLike<T> | T) => Promise<T>
