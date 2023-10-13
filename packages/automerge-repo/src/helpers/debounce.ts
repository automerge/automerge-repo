/** Debounce
 * Returns a function with a build in debounce timer that runs after `wait` ms.
 *
 * Note that the args go inside the parameter and you should be careful not to
 * recreate the function on each usage. (In React, see useMemo().)
 *
 *
 * Example usage:
 * const callback = debounce((ev) => { doSomethingExpensiveOrOccasional() }, 100)
 * target.addEventListener('frequent-event', callback);
 *
 * source: https://www.joshwcomeau.com/snippets/javascript/debounce/
 */

export const debounce = <F extends (...args: Parameters<F>) => ReturnType<F>>(
  fn: F,
  delay: number
) => {
  let timeout: ReturnType<typeof setTimeout>
  return function (...args: Parameters<F>) {
    clearTimeout(timeout)
    timeout = setTimeout(() => {
      fn.apply(null, args)
    }, delay)
  }
}
