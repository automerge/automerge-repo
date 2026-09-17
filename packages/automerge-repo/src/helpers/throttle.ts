import { AbortError } from "./abortable.js"

/** Throttle
 * Returns a function with a built in throttle timer that runs after `delay` ms.
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

export const throttle = <F extends (...args: Parameters<F>) => ReturnType<F>>(
  fn: F,
  delay: number
): ((...args: Parameters<F>) => void) => {
  let lastCall = Date.now()
  let wait: number | undefined
  let timeout: ReturnType<typeof setTimeout>
  return function (...args: Parameters<F>): void {
    // Clamp to 0: passing a negative delay to setTimeout warns on some runtimes.
    wait = Math.max(0, lastCall + delay - Date.now())
    clearTimeout(timeout)
    timeout = setTimeout(() => {
      fn(...args)
      lastCall = Date.now()
    }, wait)
  }
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
 * **Abort vs cancel**: aborting an in-flight `fn` is `fn`'s job — pass it an
 * `AbortSignal` argument. {@link AsyncThrottled.cancel} is the other half:
 * it clears a *pending* timeout so `fn` never starts. Use that from teardown
 * (document detach) so an armed timer cannot run against a document that has
 * already been released.
 *
 * @param fn - The async function to throttle
 * @param delay - Minimum delay in milliseconds between executions
 * @returns A throttled version of the function, with a {@link AsyncThrottled.cancel} method
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
 *
 * // Tear down: drop a pending (not yet started) invocation
 * throttledSave.cancel()
 * ```
 */
export type AsyncThrottled<TArgs extends unknown[], TReturn> = ((
  ...args: TArgs
) => Promise<TReturn>) & {
  /**
   * Clear a pending invocation so `fn` never runs. In-flight runs are not
   * aborted. Pending callers reject with {@link AbortError}. After cancel,
   * further calls also reject; construct a new throttle to run again.
   */
  cancel(): void
}

export const asyncThrottle = <TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  delay: number
): AsyncThrottled<TArgs, TReturn> => {
  let lastCall = Date.now()
  let timeout: ReturnType<typeof setTimeout> | undefined
  let currentPromise: Promise<TReturn> | undefined
  // A deferred shared by every call coalesced into the next run. Sharing it is
  // what keeps a superseded call from being orphaned: when a later call clears
  // the pending timeout below, the earlier call still settles with the run's
  // result (or error) instead of hanging forever.
  let pending: PromiseWithResolvers<TReturn> | undefined
  let cancelled = false

  const abort = (): Promise<TReturn> => {
    const p = Promise.reject(new AbortError()) as Promise<TReturn>
    // Fire-and-forget callers discard this promise; the handler keeps cancel
    // from surfacing as an unhandled rejection. Awaiters still observe it.
    p.catch(() => {})
    return p
  }

  const arm = (args: TArgs, deferred: PromiseWithResolvers<TReturn>) => {
    if (cancelled) return
    if (timeout) {
      clearTimeout(timeout)
    }
    // Clamp to 0: passing a negative delay to setTimeout warns on some runtimes.
    const wait = Math.max(0, lastCall + delay - Date.now()) //if negative, executes immediately
    timeout = setTimeout(async () => {
      pending = undefined
      timeout = undefined
      if (cancelled) return
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
  }

  const throttled = ((...args: TArgs): Promise<TReturn> => {
    if (cancelled) return abort()

    pending ??= Promise.withResolvers<TReturn>()
    const deferred = pending

    // Not an `async` function: callers must hold `deferred.promise` itself so
    // cancel() can reject that same object (an async wrapper would be a second
    // promise, and rejecting deferred would surface as an unhandled
    // rejection for fire-and-forget listeners).

    if (currentPromise) {
      currentPromise.then(
        () => arm(args, deferred),
        () => arm(args, deferred)
      )
    } else {
      arm(args, deferred)
    }

    return deferred.promise
  }) as AsyncThrottled<TArgs, TReturn>

  throttled.cancel = () => {
    if (cancelled) return
    cancelled = true
    if (timeout) {
      clearTimeout(timeout)
      timeout = undefined
    }
    if (pending) {
      const deferred = pending
      pending = undefined
      deferred.promise.catch(() => {})
      deferred.reject(new AbortError())
    }
  }

  return throttled
}
