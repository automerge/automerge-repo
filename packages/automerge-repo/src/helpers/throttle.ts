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
) => {
  let lastCall = Date.now()
  let wait
  let timeout: ReturnType<typeof setTimeout>
  return function (...args: Parameters<F>) {
    wait = lastCall + delay - Date.now()
    clearTimeout(timeout)
    timeout = setTimeout(() => {
      fn(...args)
      lastCall = Date.now()
    }, wait)
  }
}

/**
 * Same as {@link throttle()}, but throttles calls separately based on a
 * (weakly-referenced) key.
 *
 * Given two distinct objects `a` and `b`, and
 * `f = throttleByKey(fn, (v) => v.k, 100)`, then the following sequence of
 * calls:
 *
 * - `f({ k: a, v: 1 })`
 * - `f({ k: a, v: 2 })`
 * - `f({ k: b, v: 3 })`
 *
 * Will result in `fn({ k: a, v: 2 })` and `fn({ k: b, v: 3 }) being called
 * after 100ms. Contrast this with {@link throttle()}, which would only call
 * `fn({ k: b, v: 3 })` after 100ms.
 */
export const throttleByKey = <Arg, K extends WeakKey, F extends (arg: Arg) => ReturnType<F>>(
  fn: F,
  key: (arg: Arg) => K,
  delay: number
) => {
  const callTimeouts = new WeakMap<K, /*lastArg=*/Arg>()

  return function (arg: Arg) {
    const k = key(arg)

    if (!callTimeouts.has(k)) {
      // No timeout yet, set it up.
      setTimeout(() => {
        const lastArg = callTimeouts.get(k)
        if (lastArg !== undefined) {
          callTimeouts.delete(k)
          fn(lastArg)
        }
      }, delay)
    }

    callTimeouts.set(k, arg)
  }
}
