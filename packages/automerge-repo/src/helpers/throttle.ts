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
    wait = lastCall + delay - Date.now()
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

    // Clear any pending timeout
    if (timeout) {
      clearTimeout(timeout)
    }

    const wait = lastCall + delay - Date.now() //if negative, executes immediately

    return new Promise<TReturn>((resolve, reject) => {
      timeout = setTimeout(async () => {
        try {
          currentPromise = fn(...args)
          resolve(await currentPromise)
        } catch (error) {
          reject(error)
        } finally {
          lastCall = Date.now()
          currentPromise = undefined
          timeout = undefined
        }
      }, wait)
    })
  }
}
