/**
 * Test helpers for GC-dependent tests.
 *
 * Requires the test runner to expose `globalThis.gc` (run with --expose-gc).
 * Use {@link gcAvailable} (or the `itGC` pattern) to skip cleanly when
 * unavailable:
 *
 *   const itGC = gcAvailable ? it : it.skip
 *   itGC("...", async () => { ... })
 *
 * Two flavors are exported:
 *   - {@link waitForGC} — adaptive: poll a WeakRef (or predicate) until
 *     collection is observed or `timeoutMs` elapses. Use for *positive*
 *     collection assertions.
 *   - {@link flushGC} — fixed: fire `rounds` GC cycles unconditionally. Use
 *     for *negative* assertions (something is strongly held and should still
 *     be present after a best-effort GC).
 *
 * ## CI flakiness defenses
 *
 * GC tests are inherently engine-timing-dependent and have a reputation for
 * being flaky. The defenses here are deliberate:
 *
 *   - **Adaptive polling, not fixed sleeps.** {@link waitForGC} exits as
 *     soon as collection is observed, so a fast engine pays ~5 ms while a
 *     loaded CI machine still gets the full timeout budget. No wall-clock
 *     "wait N seconds and hope" anywhere in the success path.
 *   - **Timeout is a failure budget, not a wait.** The success path never
 *     pays the timeout. The 1 s default exists only so a genuine leak
 *     surfaces as a deterministic failed assertion within bounded time
 *     instead of hanging the suite.
 *   - **Boolean return + explicit `expect(...).toBe(true)`.** A timeout
 *     turns into a loud failed assertion, never a silent pass. Compare
 *     `await flushGC(); expect(probe.deref()).toBeUndefined()`, where a
 *     missed collection produces a useful error only by luck of which
 *     assertion fires first.
 *   - **Macrotask yield is mandatory.** V8 retains the value returned by
 *     `WeakRef.deref()` until the end of the current Job — and microtask
 *     boundaries (`Promise.resolve()`, `queueMicrotask`) empirically do
 *     NOT release that pin. We use `setImmediate`. The loop in
 *     {@link waitForGC} also orders check-then-yield-then-gc so the pin
 *     from the previous iteration's deref is released before the next
 *     `gc()` runs.
 *   - **Vitest fake timers do not apply.** Fake timers mock `setTimeout` /
 *     `setImmediate` / `Date`, but `globalThis.gc()` and
 *     `FinalizationRegistry` callbacks are V8 internals and are not
 *     faked. Real macrotask yields are required for finalizers to drain.
 */

const callGC = (): void => {
  const gc = globalThis.gc
  if (typeof gc !== "function") {
    throw new Error(
      "GC helpers require --expose-gc; configure vitest test.execArgv"
    )
  }
  // Use the no-arg form. Empirically (Node 20), passing the options object
  // — even `{ execution: "sync", type: "major" }` — leaves WeakRef targets
  // observably alive after a setImmediate yield, while `gc()` collects them.
  // The no-arg default is full-mark-sweep on V8/Node, which is what we want.
  gc()
}

const yieldForFinalizers = (): Promise<void> =>
  // setImmediate yields the macrotask queue, which drains microtasks first —
  // FinalizationRegistry callbacks are scheduled as microtasks, so they run
  // before the next round.
  new Promise(resolve => setImmediate(resolve))

/**
 * Force GC cycles and yield until `target` is satisfied, or `timeoutMs`
 * elapses. `target` may be:
 *   - a `WeakRef`, satisfied once `.deref()` returns `undefined`
 *   - a predicate, satisfied once it returns `true`
 *
 * Returns `true` if observed before the timeout, `false` on timeout. Always
 * test the boolean explicitly so a CI miss is a loud failed assertion:
 *
 *   expect(await waitForGC(probe)).toBe(true)
 *
 * `timeoutMs` is a *failure budget*, not a wait. The loop exits as soon as
 * collection is observed (typically 2 iterations / a few ms), so success
 * never pays the timeout. The default 1 s exists so a genuine leak fails
 * deterministically within bounded time instead of hanging the suite.
 *
 * Loop ordering matters. `WeakRef.deref()` retains the returned value until
 * the end of the current Job (V8's kept-alive list, cleared at macrotask
 * boundaries — microtask yields like `Promise.resolve()` are NOT enough).
 * The order is:
 *   1. check predicate (may deref → pins value for this Job)
 *   2. yield (macrotask boundary releases the pin)
 *   3. gc() (now able to collect)
 *   4. yield (FinalizationRegistry callbacks fire)
 * Putting gc() before the yield-after-check would re-pin via the next
 * iteration's check before gc could collect — empirically this never
 * converges.
 */
export async function waitForGC(
  target: WeakRef<WeakKey> | (() => boolean),
  timeoutMs = 1000
): Promise<boolean> {
  const isDone =
    typeof target === "function"
      ? target
      : (): boolean => target.deref() === undefined

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (isDone()) return true
    await yieldForFinalizers()
    callGC()
    await yieldForFinalizers()
  }
  return false
}

/**
 * Fire a fixed number of GC cycles, yielding for finalizer callbacks between
 * each. Use when there is no specific WeakRef to await — e.g. asserting that
 * a strongly-held value is *not* collected. For positive collection
 * assertions prefer {@link waitForGC}.
 */
export async function flushGC(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    callGC()
    await yieldForFinalizers()
  }
}

/** Skip-when-unavailable guard for GC-dependent tests. */
export const gcAvailable = typeof globalThis.gc === "function"
