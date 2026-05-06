/**
 * Force a few GC cycles and yield long enough for FinalizationRegistry
 * callbacks to run. Multiple rounds because young-generation collection
 * may not promote/finalize on the first sweep.
 *
 * Requires the test runner to expose `globalThis.gc` (run with --expose-gc).
 * Use the `itGC` guard if your test should skip cleanly when unavailable.
 */
export async function flushGC(rounds = 3): Promise<void> {
  if (typeof globalThis.gc !== "function") {
    throw new Error(
      "flushGC requires --expose-gc; configure vitest poolOptions.{forks,threads}.execArgv"
    )
  }
  for (let i = 0; i < rounds; i++) {
    globalThis.gc()
    await new Promise(resolve => setImmediate(resolve))
  }
}

/** Skip-when-unavailable guard for GC-dependent tests. */
export const gcAvailable = typeof globalThis.gc === "function"
