/**
 * An error thrown when an operation is aborted.
 *
 * @remarks
 * This error is thrown when an operation is aborted. It is a subclass of DOMException
 * with name "AbortError".
 *
 * @example
 * ```typescript
 * throw new AbortError()
 * ```
 */
export class AbortError extends DOMException {
  constructor(message?: string) {
    super(message ?? "Operation aborted", "AbortError")
  }
}

/**
 * Detects if candidate `Error` is an `AbortError` or AbortError-like.
 * @remarks
 * - This method detects if an error is AbortError-like (for which there could be many implementations)
 * - AbortController spec defines AbortError as DOMException or Error with `name === 'AbortError'`.
 */
export const isAbortErrorLike = (candidate: unknown): boolean => {
  return (
    candidate instanceof AbortError ||
    ((candidate instanceof Error ||
      //In some JS environments, DOMException is not defined, and sometimes when defined, it does not extend Error; hence extra checks
      (DOMException && candidate instanceof DOMException)) &&
      candidate.name === "AbortError")
  )
}

/**
 * Wraps a Promise and causes it to reject when the signal is aborted.
 *
 * @remarks
 * This utility wraps a Promise and rejects when the provided AbortSignal is aborted.
 * It's designed to make Promise awaits abortable.
 *
 * @example
 * ```typescript
 * const controller = new AbortController();
 *
 * try {
 *   const result = await abortable(fetch('https://api.example.com/data'), controller.signal);
 *   // Meanwhile, to abort in concurrent code before the above line returns: controller.abort();
 * } catch (err) {
 *   if (err.name === 'AbortError') {
 *     console.log('The operation was aborted');
 *   }
 * }
 *
 * ```
 *
 * @param p - A Promise to wrap
 * @param signal - An AbortSignal that can be used to abort the operation
 * @returns A wrapper Promise that rejects with AbortError if the signal is aborted
 * before the promise p settles, and settles as p settles otherwise
 * @throws {DOMException} With name "AbortError" if aborted before p settles
 */
export function abortable<T>(
  p: Promise<T>,
  signal: AbortSignal | undefined
): Promise<T> {
  let settled = false
  return new Promise((resolve, reject) => {
    signal?.addEventListener(
      "abort",
      () => {
        if (!settled) {
          reject(new AbortError())
        }
      },
      { once: true }
    )
    p.then(result => {
      resolve(result)
    })
      .catch(error => {
        reject(error)
      })
      .finally(() => {
        settled = true
      })
  })
}

/**
 * Include this type in an options object to pass an AbortSignal to a function.
 */
export interface AbortOptions {
  signal?: AbortSignal
}
