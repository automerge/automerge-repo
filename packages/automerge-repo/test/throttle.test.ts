import { describe, it, expect } from "vitest"
import { asyncThrottle, throttle } from "../src/helpers/throttle.js"
import { pause } from "../src/helpers/pause.js"

describe("asyncThrottle", () => {
  it("serializes a slow async fn: two invocations never run concurrently", async () => {
    let concurrent = 0
    let maxConcurrent = 0
    let callCount = 0

    const fn = async () => {
      callCount++
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await pause(80)
      concurrent--
    }

    const throttled = asyncThrottle(fn, 20)

    const p1 = throttled() // T=0: p1's fn scheduled to start at T=20 (DELAY)
    await pause(40) // T≈40: p1's fn started at T=20 and is still running (until T=100)
    const p2 = throttled() // T≈40: suspends internally on `await currentPromise` (p1's fn)
    await Promise.all([p1, p2]) // T≈200: p1 resolves at T=100 (its fn done); p2 at T=200

    expect(maxConcurrent).toBe(1)
    expect(callCount).toBe(2)
  })

  it("coalesces rapid calls and runs fn with the latest args only", async () => {
    const calls: number[] = []
    const throttled = asyncThrottle(async (x: number) => {
      calls.push(x)
      await pause(20) // simulate real async work
    }, 30)

    throttled(1) // T=0: schedules fn at T=30 (DELAY)
    throttled(2) // T≈0: clears previous timeout, reschedules at T=30
    const last = throttled(3) // T≈0: clears previous, reschedules at T=30 with args=3
    await last // T≈50: fn starts at T=30 with args=3, finishes at T=50

    expect(calls.length).toBe(1) // coalesced: fn ran exactly once
    expect(calls[0]).toBe(3) // ...with the latest args
  })

  it("returns a Promise that resolves with fn's return value", async () => {
    const throttled = asyncThrottle(async (n: number) => n * 2, 10)
    const result = await throttled(21) // T=0 → T≈10: fn(21) runs at T=10, returns 42
    expect(result).toBe(42)
  })

  it("rejects the returned promise when fn throws", async () => {
    const throttled = asyncThrottle(async () => {
      throw new Error("boom")
    }, 10)
    await expect(throttled()).rejects.toThrow("boom") // T=0 → T≈10: fn throws, rejected promise propagates
  })

  it("measures the minimum gap between executions from the end of the previous run", async () => {
    const starts: number[] = []
    const FN_DURATION = 100
    const DELAY = 30

    const throttled = asyncThrottle(async () => {
      starts.push(Date.now())
      await pause(FN_DURATION)
    }, DELAY)

    const p1 = throttled() // T=0: schedules p1's fn at T=30 (DELAY)
    // Wait past the throttle DELAY so call 1's fn is actually running
    // (if call 2 arrives before call 1's timeout fires, call 1's promise
    // is orphaned and the second run's fn gets called with call 2's args).
    await pause(DELAY + 20) // T≈50: p1's fn started at T=30, still running (until T=130)
    const p2 = throttled() // T≈50: suspends internally on `await currentPromise` (p1's fn)
    await Promise.all([p1, p2]) // T≈260: p1 resolves at T=130; p2's fn runs T=160-260

    expect(starts.length).toBe(2)
    const gap = starts[1] - starts[0]
    // Gap must reflect waiting for the previous fn to settle (FN_DURATION)
    // *then* the throttle delay - not just DELAY from the first start.
    // Allow small negative drift from timer resolution.
    expect(gap).toBeGreaterThanOrEqual(FN_DURATION + DELAY - 10)
  })

  it("cancels a pending invocation when called again before the delay elapses", async () => {
    // Record the `x` passed to every fn invocation that actually ran.
    // Because push is the FIRST line of fn, if fn(1) had even started,
    // `ranWith` would contain 1 — regardless of whether it reached the pause.
    const ranWith: number[] = []
    const throttled = asyncThrottle(async (x: number) => {
      ranWith.push(x)
      await pause(20) // simulate real async work
    }, 50)

    void throttled(1) // T=0: schedules fn(1) at T=50; pending timeout will be replaced below
    await pause(10) // T≈10: still within the 50ms delay window, fn(1)'s timeout hasn't fired
    await throttled(2) // T≈70: clears (1)'s timeout, reschedules; fn(2) starts at T=50, finishes at T=70

    expect(ranWith).not.toContain(1) // fn(1) never ran — its pending timeout was cleared
    expect(ranWith).toEqual([2]) // ...and fn(2) ran in its place
  })
})

describe("throttle vs asyncThrottle: the concurrency property", () => {
  it("plain throttle allows overlapping fn runs when fn exceeds the delay; asyncThrottle prevents them", async () => {
    const DELAY = 30
    const FN_DURATION = 100

    const makeProbe = () => {
      let concurrent = 0
      let maxConcurrent = 0
      return {
        async fn() {
          concurrent++
          maxConcurrent = Math.max(maxConcurrent, concurrent)
          await pause(FN_DURATION)
          concurrent--
        },
        getMax: () => maxConcurrent,
      }
    }

    // Plain throttle: fires fn and forgets; a second call during fn's
    // execution schedules another fn run that overlaps the first.
    const plainProbe = makeProbe()
    const plainThrottled = throttle(() => {
      void plainProbe.fn()
    }, DELAY)

    plainThrottled() // T=0: schedules fn at T=30 (DELAY)
    await pause(50) // T≈50: fn1 started at T=30, still running (until T=130)
    plainThrottled() // T≈50: reschedules fn at T=60 (doesn't wait for fn1); fn2 starts at T=60, ends T=160
    await pause(FN_DURATION + DELAY + 50) // T≈230: both fn1 (T=30-130) and fn2 (T=60-160) done; they overlapped T=60-130

    // Undesired behavior: plain throttle let fn runs overlap. This is the
    // race that motivated asyncThrottle.
    expect(plainProbe.getMax()).toBeGreaterThan(1)

    // asyncThrottle: the second call awaits the first fn's promise before
    // scheduling, so the two fn invocations never overlap.
    const asyncProbe = makeProbe()
    const asyncThrottled = asyncThrottle(asyncProbe.fn, DELAY)
    // Subsection timeline below is measured from the line above (resets T=0).

    const p1 = asyncThrottled() // T=0: schedules p1's fn at T=30 (DELAY)
    await pause(50) // T≈50: p1's fn started at T=30, still running (until T=130)
    const p2 = asyncThrottled() // T≈50: suspends on `await currentPromise` (p1's fn)
    await Promise.all([p1, p2]) // T≈260: p1 resolves at T=130; p2's fn runs T=160-260

    // Desired behavior: asyncThrottle kept max concurrent fn runs at 1,
    // despite identical call timing to the plain-throttle case above.
    expect(asyncProbe.getMax()).toBe(1)
  })
})
