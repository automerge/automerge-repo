/**
 * Poll `callback` until it runs without throwing, then resolve.
 *
 * The callback is the predicate: a thrown assertion (e.g. a failing `expect`)
 * means "not ready yet", so it is caught and retried with backoff. When
 * `timeout` is given, the wait is bounded and rejects on expiry with the last
 * assertion's message (and `cause`), so a stuck wait fails fast and explains
 * why. Omit `timeout` to keep the original unbounded behavior (the enclosing
 * test's own timeout then applies).
 */
export async function waitFor(
  callback: () => void | Promise<void>,
  timeout?: number
) {
  const deadline = timeout == null ? undefined : Date.now() + timeout
  let sleepMs = 10
  let lastError: unknown
  while (true) {
    try {
      await callback()
      break
    } catch (e) {
      lastError = e
      if (deadline != null && Date.now() >= deadline) {
        const reason =
          lastError instanceof Error ? lastError.message : String(lastError)
        throw new Error(`waitFor timed out after ${timeout}ms: ${reason}`, {
          cause: lastError,
        })
      }
      // Uncapped backoff when untimed (the original behavior other suites rely
      // on); capped when bounded so the deadline is honored within ~100ms.
      sleepMs = deadline == null ? sleepMs * 2 : Math.min(sleepMs * 2, 100)
      await new Promise(resolve => {
        setTimeout(resolve, sleepMs)
      })
    }
  }
}
