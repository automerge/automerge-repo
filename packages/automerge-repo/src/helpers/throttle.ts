/** Throttle
 * Returns a function with a built in throttle timer.
 *
 * This is a leading+trailing edge throttle:
 * - First call executes immediately (leading edge)
 * - Subsequent calls within delay are batched
 * - Final call in a burst is also executed (trailing edge)
 *
 * Here's a diagram:
 *
 * calls +----++++++-----++----
 * dlay  v--^ v--^v--^   v--^
 * execs +------+---+---+----+-
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
  /** Immediately execute any pending throttled call */
  flush: () => void
}

export const throttle = <F extends (...args: any[]) => any>(
  fn: F,
  delay: number
): ThrottledFunction<F> => {
  let lastCall = 0 // Start at 0 so first call is immediate
  let timeout: ReturnType<typeof setTimeout> | undefined
  let pendingArgs: Parameters<F> | undefined

  const throttled = function (...args: Parameters<F>) {
    const now = Date.now()
    const timeSinceLastCall = now - lastCall

    // If enough time has passed, execute immediately (leading edge)
    if (timeSinceLastCall >= delay) {
      clearTimeout(timeout)
      timeout = undefined
      pendingArgs = undefined
      lastCall = now
      fn(...args)
    } else {
      // Otherwise, schedule for trailing edge
      pendingArgs = args
      if (!timeout) {
        const remaining = delay - timeSinceLastCall
        timeout = setTimeout(() => {
          timeout = undefined
          if (pendingArgs) {
            lastCall = Date.now()
            fn(...pendingArgs)
            pendingArgs = undefined
          }
        }, remaining)
      }
    }
  } as ThrottledFunction<F>

  throttled.flush = () => {
    if (timeout) {
      clearTimeout(timeout)
      timeout = undefined
    }
    if (pendingArgs) {
      lastCall = Date.now()
      fn(...pendingArgs)
      pendingArgs = undefined
    }
  }

  return throttled
}
