import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { asyncThrottle, throttle } from "../src/helpers/throttle.js"
import { pause } from "../src/helpers/pause.js"

// These tests use two complementary styles deliberately:
//
// 1. **Fake timers** (the `asyncThrottle` describe and the fake half of
//    the concurrency-property pair below) verify logical timing
//    behavior — coalescing, cancellation, return-value plumbing, error
//    propagation, gap measurement, in-process serialization, overlap
//    detection. The assertions are about *what* runs *with what args*
//    *in what order*; real wall-clock time is incidental, and faking it
//    makes the tests fast and deterministic.
//
// 2. **Real timers** (the real half of the concurrency-property pair)
//    are defense-in-depth: the fake-timer suite already covers the
//    logical bug, but real timers also exercise the implementation
//    against actual setTimeout, real microtask/macrotask interleaving,
//    and real event-loop scheduling. We don't have a known case where
//    real timers would catch a bug the fake-timer suite misses, but
//    they're cheap insurance against scheduling quirks vitest's fake
//    timer might not model perfectly.
//
//    Real timers are subject to scheduling variability — a single run
//    could mask a bug that allows overlap (false pass on asyncThrottle)
//    or fail to observe the overlap plain throttle is supposed to
//    exhibit (false fail on plain throttle). Each real-timer test runs
//    N iterations to reduce both flake risks.
//
// Default to fake. Real-timer iteration is reserved for the
// concurrency property because it's the headline behavioral guarantee
// of asyncThrottle.

describe("asyncThrottle", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

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
    await vi.advanceTimersByTimeAsync(40) // T≈40: p1's fn started at T=20 and is still running (until T=100)
    const p2 = throttled() // T≈40: suspends internally on `await currentPromise` (p1's fn)
    await vi.advanceTimersByTimeAsync(200) // T≈240: p1 resolves at T=100; p2's fn runs T=120-200
    await Promise.all([p1, p2])

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
    await vi.advanceTimersByTimeAsync(50) // T≈50: fn starts at T=30 with args=3, finishes at T=50
    await last

    expect(calls.length).toBe(1) // coalesced: fn ran exactly once
    expect(calls[0]).toBe(3) // ...with the latest args
  })

  it("returns a Promise that resolves with fn's return value", async () => {
    const throttled = asyncThrottle(async (n: number) => n * 2, 10)
    const p = throttled(21) // T=0: fn scheduled at T=10
    await vi.advanceTimersByTimeAsync(10)
    expect(await p).toBe(42)
  })

  it("rejects the returned promise when fn throws", async () => {
    const throttled = asyncThrottle(async () => {
      throw new Error("boom")
    }, 10)
    // Attach the rejection assertion synchronously so the rejection handler
    // is in place before advanceTimersByTimeAsync fires the fn. Without
    // this the rejection lands during the timer tick with no attached
    // handler and vitest reports an "unhandled rejection."
    const assertion = expect(throttled()).rejects.toThrow("boom")
    await vi.advanceTimersByTimeAsync(10) // T=10: fn throws, rejected promise propagates
    await assertion
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
    await vi.advanceTimersByTimeAsync(DELAY + 20) // T≈50: p1's fn started at T=30, still running (until T=130)
    const p2 = throttled() // T≈50: suspends internally on `await currentPromise` (p1's fn)
    await vi.advanceTimersByTimeAsync(FN_DURATION + DELAY + FN_DURATION) // drain through p2's run
    await Promise.all([p1, p2])

    expect(starts.length).toBe(2)
    const gap = starts[1] - starts[0]
    // Gap reflects waiting for the previous fn to settle (FN_DURATION)
    // *then* the throttle delay. With fake timers there is no drift, but
    // we keep the same tolerance the real-timer version of this test had
    // so the assertion documents the same invariant either way.
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
    await vi.advanceTimersByTimeAsync(10) // T≈10: still within the 50ms delay window, fn(1)'s timeout hasn't fired
    const p = throttled(2)
    await vi.advanceTimersByTimeAsync(70) // T≈80: clears (1)'s timeout, reschedules; fn(2) starts at T=60, finishes at T=80
    await p

    expect(ranWith).not.toContain(1) // fn(1) never ran — its pending timeout was cleared
    expect(ranWith).toEqual([2]) // ...and fn(2) ran in its place
  })
})

// -- Concurrency property ----------------------------------------------------
//
// The headline behavioral guarantee of asyncThrottle: a second call that
// arrives while fn is still running awaits the first fn's promise before
// scheduling the second invocation. Plain throttle does NOT do this — a
// second call schedules a fresh fn run that overlaps with the first. We
// verify both halves of the comparison in both timer modes.

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

/**
 * Exercise plain throttle against the racing-call scenario and return the
 * observed maximum concurrent fn invocations. With plain throttle, the
 * second call schedules a fresh fn before the first has finished, so the
 * two invocations overlap.
 */
const exercisePlainThrottle = async (
  advance: (ms: number) => Promise<void>
): Promise<number> => {
  const probe = makeProbe()
  const throttled = throttle(() => {
    void probe.fn()
  }, DELAY)

  throttled() // T=0: schedules fn at T=30 (DELAY)
  await advance(50) // T≈50: fn1 started at T=30, still running (until T=130)
  throttled() // T≈50: reschedules fn at T=60; fn2 starts at T=60, ends T=160
  await advance(FN_DURATION + DELAY + 50) // T≈230: both fn1 and fn2 done

  return probe.getMax()
}

/**
 * Exercise asyncThrottle against the same racing-call scenario and return
 * the observed maximum concurrent fn invocations. asyncThrottle suspends
 * the second call on `await currentPromise`, so the two fn invocations
 * never overlap.
 */
const exerciseAsyncThrottle = async (
  advance: (ms: number) => Promise<void>
): Promise<number> => {
  const probe = makeProbe()
  const throttled = asyncThrottle(probe.fn, DELAY)

  const p1 = throttled() // T=0: schedules p1's fn at T=30 (DELAY)
  await advance(50) // T≈50: p1's fn started at T=30, still running (until T=130)
  const p2 = throttled() // T≈50: suspends on `await currentPromise` (p1's fn)
  // Drain enough fake/real time for p2's fn to start and finish:
  //   p1 resolves at T=130; p2's fn runs T=160-260; then asyncThrottle
  //   resolves p2. Allow some slack for real-timer scheduling.
  await advance(FN_DURATION + DELAY + FN_DURATION + 50)
  await Promise.all([p1, p2])

  return probe.getMax()
}

describe("concurrency property (fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)

  it("plain throttle allows overlapping fn runs", async () => {
    expect(await exercisePlainThrottle(advance)).toBeGreaterThan(1)
  })

  it("asyncThrottle prevents overlapping fn runs", async () => {
    expect(await exerciseAsyncThrottle(advance)).toBe(1)
  })
})

describe("concurrency property (real timers, multi-iteration)", () => {
  // Real timers as defense-in-depth + flake reduction. The asyncThrottle
  // assertion runs across every iteration: a single bug-induced overlap
  // anywhere fails the test. The plain-throttle assertion only requires
  // that overlap happens *at least once* — scheduling variability under
  // load can collapse the overlap window in any single run, but at least
  // one run in N should show it.

  const ITERATIONS = 3

  it("asyncThrottle prevents overlap across all iterations", async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const max = await exerciseAsyncThrottle(pause)
      expect(max, `iteration ${i + 1}/${ITERATIONS}`).toBe(1)
    }
  })

  it("plain throttle exhibits overlap in at least one iteration", async () => {
    const observed: number[] = []
    for (let i = 0; i < ITERATIONS; i++) {
      observed.push(await exercisePlainThrottle(pause))
    }
    expect(
      Math.max(...observed),
      `observed max-concurrent across iterations: ${observed.join(", ")}`
    ).toBeGreaterThan(1)
  })
})
