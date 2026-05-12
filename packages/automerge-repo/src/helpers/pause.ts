/* c8 ignore start */
import { AbortError } from "./abortable.js"

type AbortListener = (
  this: AbortSignal,
  ev: AbortSignalEventMap["abort"]
) => void

const abortEvent = "abort"

/**
 * Creates a promise that resolves after a specified number of milliseconds.
 * The pause can be aborted using an AbortSignal.
 *
 * @param milliseconds - The number of milliseconds to pause. Defaults to 0.
 * @param signal - An optional AbortSignal that can be used to cancel the pause.
 * @returns A Promise that resolves after the specified delay, or rejects with an AbortError if cancelled.
 *
 * @throws {AbortError} Thrown when the pause is cancelled via the AbortSignal.
 *
 * @example
 * ```typescript
 * // Basic usage
 * await pause(1000); // Pause for 1 second
 *
 * // With abort signal
 * const controller = new AbortController();
 * setTimeout(() => controller.abort(), 500); // Cancel after 500ms
 * await pause(1000, controller.signal); // Will be cancelled
 * ```
 *
 * @remarks
 * Multiple signals can be observed using the AbortSignal.any() static method.
 * This allows you to pause until either the timeout completes or any of multiple
 * abort signals are triggered.
 *
 * @example
 * ```typescript
 * const signal1 = new AbortController().signal;
 * const signal2 = new AbortController().signal;
 * const combinedSignal = AbortSignal.any([signal1, signal2]);
 * await pause(5000, combinedSignal); // Pause until timeout or either signal aborts
 * ```
 */
export const pause = (
  milliseconds: number = 0,
  options?: { signal?: AbortSignal }
) => {
  return new Promise<void>((resolve, reject) => {
    const { signal } = options ?? {}
    if (signal?.aborted) {
      reject(new AbortError())
      return
    }
    const abortListener: AbortListener | undefined =
      signal &&
      ((): void => {
        reject(new AbortError())
        clearTimeout(id)
      })

    abortListener &&
      signal?.addEventListener(abortEvent, abortListener, { once: true })

    const id = setTimeout(() => {
      resolve()
      abortListener && signal?.removeEventListener(abortEvent, abortListener)
    }, milliseconds)
  })
}

/* c8 ignore end */
