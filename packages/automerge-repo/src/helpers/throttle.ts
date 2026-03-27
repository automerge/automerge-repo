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
    wait = lastCall + delay - Date.now()
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
