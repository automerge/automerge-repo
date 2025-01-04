/**
 * Creates a promise that rejects when the signal is aborted.
 *
 * @remarks
 * This utility creates a promise that rejects when the provided AbortSignal is aborted.
 * It's designed to be used with Promise.race() to make operations abortable.
 *
 * @example
 * ```typescript
 * const controller = new AbortController();
 *
 * try {
 *   const result = await Promise.race([
 *     fetch('https://api.example.com/data'),
 *     abortable(controller.signal)
 *   ]);
 * } catch (err) {
 *   if (err.name === 'AbortError') {
 *     console.log('The operation was aborted');
 *   }
 * }
 *
 * // Later, to abort:
 * controller.abort();
 * ```
 *
 * @param signal - An AbortSignal that can be used to abort the operation
 * @param cleanup - Optional cleanup function that will be called if aborted
 * @returns A promise that rejects with AbortError when the signal is aborted
 * @throws {DOMException} With name "AbortError" when aborted
 */
export function abortable(
  signal?: AbortSignal,
  cleanup?: () => void
): Promise<never> {
  if (signal?.aborted) {
    throw new DOMException("Operation aborted", "AbortError")
  }

  if (!signal) {
    return new Promise(() => {}) // Never resolves
  }

  return new Promise((_, reject) => {
    signal.addEventListener(
      "abort",
      () => {
        cleanup?.()
        reject(new DOMException("Operation aborted", "AbortError"))
      },
      { once: true }
    )
  })
}

/**
 * Include this type in an options object to pass an AbortSignal to a function.
 */
export interface AbortOptions {
  signal?: AbortSignal
}
