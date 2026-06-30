/** Throttle
 * Returns a function with a built-in throttle timer that runs after `delay` ms.
 *
 * This function differs from a conventional `throttle` in that it ensures the final
 * call will also execute and delays sending the first one until `delay` ms to allow
 * additional work to accumulate.
 *
 * Here's a diagram:
 *
 * calls +----++++++-----++----
 * dlay  ^--v ^--v^--v   ^--v
 * execs ---+----+---+------+--
 *
 * The goal in this design is to create batches of changes without flooding
 * communication or storage systems while still feeling responsive.
 * (By default we communicate at 10hz / every 100ms.)
 *
 * Note that the args go inside the parameter and you should be careful not to
 * recreate the function on each usage. (In React, see useMemo().)
 *
 *
 * Example usage:
 * const callback = throttle((ev) => { doSomethingExpensiveOrOccasional() }, 100)
 * target.addEventListener('frequent-event', callback);
 *
 */

export type ThrottledFunction<F extends (...args: any[]) => any> = {
  (...args: Parameters<F>): void
  /** Immediately execute any pending throttled call. */
  flush: () => void
}

export const throttle = <F extends (...args: any[]) => any>(
  fn: F,
  delay: number
): ThrottledFunction<F> => {
  let lastCall = Date.now()
  let wait: number
  let timeout: ReturnType<typeof setTimeout> | undefined
  let pendingArgs: Parameters<F> | undefined

  const throttled = function (...args: Parameters<F>) {
    pendingArgs = args
    // Clamp to 0: passing a negative delay to setTimeout warns on some runtimes.
    wait = Math.max(0, lastCall + delay - Date.now())
    clearTimeout(timeout)
    timeout = setTimeout(() => {
      timeout = undefined
      pendingArgs = undefined
      fn(...args)
      lastCall = Date.now()
    }, wait)
  } as ThrottledFunction<F>

  throttled.flush = () => {
    clearTimeout(timeout)
    timeout = undefined
    if (pendingArgs) {
      fn(...pendingArgs)
      pendingArgs = undefined
      lastCall = Date.now()
    }
  }

  return throttled
}

/**
 * Throttles an async function to execute at most once per delay period
 *
 * Unlike regular throttle, this ensures:
 * - Previous calls complete before new ones start (so there is no race with previous calls)
 * - There's always a minimum delay between executions
 * - The latest call always runs (canceling previous pending calls)
 * - Superseded calls still settle — every coalesced caller resolves (or rejects)
 *   with the winning run's result rather than being left with an orphaned promise
 * - Each call waits for the previous execution to complete
 *
 * This creates a batching behavior that prevents flooding while ensuring
 * the final state is always committed.
 *
 * **Note on AbortSignal**: If you need abort functionality, implement it as an
 * argument to `fn`. The wrapped function is responsible for responding to the
 * abort signal, not the throttle mechanism itself.
 *
 * @param fn - The async function to throttle
 * @param delay - Minimum delay in milliseconds between executions
 * @returns A throttled version of the function
 *
 * @example
 * ```typescript
 * const throttledSave = asyncThrottle(async (data) => {
 *   await save(data)
 * }, 100)
 *
 * // Multiple rapid calls will be throttled
 * throttledSave(data1) // Waits 100ms, then executes
 * throttledSave(data2) // Waits for data1 to complete + 100ms delay
 * throttledSave(data3) // Cancels data2, waits for data1 + 100ms delay
 *
 * // Example with AbortSignal support
 * const throttledFetch = asyncThrottle(async (url, signal) => {
 *   return fetch(url, { signal })
 * }, 100)
 * const controller = new AbortController()
 * throttledFetch('/api/data', controller.signal)
 * controller.abort() // Aborts the fetch inside fn
 * ```
 */
export const asyncThrottle = <TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  delay: number
): ((...args: TArgs) => Promise<TReturn>) => {
  let lastCall = Date.now()
  let timeout: ReturnType<typeof setTimeout> | undefined
  let currentPromise: Promise<TReturn> | undefined
  // A deferred shared by every call coalesced into the next run. Sharing it is
  // what keeps a superseded call from being orphaned: when a later call clears
  // the pending timeout below, the earlier call still settles with the run's
  // result (or error) instead of hanging forever.
  let pending: PromiseWithResolvers<TReturn> | undefined

  return async function (...args: TArgs): Promise<TReturn> {
    // Wait for any previous call to settle, so that there is not a race with
    // throttled calls still running
    if (currentPromise) {
      try {
        await currentPromise
      } catch {
        // noop if error thrown here (just waiting for it to settle)
      }
    }

    // Join (or open) the batch waiting on the next run. Every caller shares this
    // deferred; the run itself uses the latest call's args, captured below.
    pending ??= Promise.withResolvers<TReturn>()
    const deferred = pending

    // Clear any pending timeout
    if (timeout) {
      clearTimeout(timeout)
    }

    // Clamp to 0: passing a negative delay to setTimeout warns on some runtimes.
    const wait = Math.max(0, lastCall + delay - Date.now())

    timeout = setTimeout(async () => {
      pending = undefined
      timeout = undefined
      try {
        currentPromise = fn(...args)
        deferred.resolve(await currentPromise)
      } catch (error) {
        deferred.reject(error)
      } finally {
        lastCall = Date.now()
        currentPromise = undefined
      }
    }, wait)

    return deferred.promise
  }
}
