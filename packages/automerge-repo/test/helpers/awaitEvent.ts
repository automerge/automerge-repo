/**
 * Resolve when `emitter` fires `eventName` with an argument satisfying
 * `predicate` (default: the next occurrence), returning that argument. This is
 * the event-driven primitive the test waits should prefer: key off the signal
 * the code already emits rather than polling for its effect.
 *
 * Pass `timeout` to bound the wait and reject with a clear error if no matching
 * event arrives; omit it to fall back on the enclosing test's own timeout.
 */
export async function awaitEvent<T = unknown>(
  emitter: { on(...args: any[]): void; off(...args: any[]): void },
  eventName: string,
  predicate: (arg: T) => boolean = () => true,
  { timeout }: { timeout?: number } = {}
): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const onEvent = (arg: T) => {
    if (!predicate(arg)) return
    emitter.off(eventName, onEvent)
    if (timer != null) clearTimeout(timer)
    resolve(arg)
  }
  emitter.on(eventName, onEvent)
  if (timeout != null) {
    timer = setTimeout(() => {
      emitter.off(eventName, onEvent)
      reject(
        new Error(`awaitEvent("${eventName}") timed out after ${timeout}ms`)
      )
    }, timeout)
  }
  return promise
}
