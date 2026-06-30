/**
 * Helpers for the real-browser storage bench (`StorageBench.browser.test.ts`).
 *
 * Not a test file — the browser bench config only includes `*.browser.test.ts`,
 * and the default suite excludes both.
 */

export interface WorkloadResult {
  /** Wall-clock time for the workload. */
  wallMs: number
  /** Longest single main-thread block (max gap between animation frames). */
  maxBlockMs: number
  /** Total main-thread time spent blocked beyond one frame budget (~jank). */
  jankMs: number
  /** Animation frames observed (lower under heavy main-thread blocking). */
  frames: number
}

const FRAME_BUDGET_MS = 16

export const median = (xs: number[]): number => {
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

/** A random buffer (chunked: `crypto.getRandomValues` caps at 65536 bytes). */
export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  for (let off = 0; off < n; off += 65536) {
    crypto.getRandomValues(out.subarray(off, Math.min(off + 65536, n)))
  }
  return out
}

const raf = () => new Promise<number>(resolve => requestAnimationFrame(resolve))

/**
 * Run `work()` while sampling main-thread responsiveness via the gaps between
 * animation frames (a blocked main thread can't paint). Optionally burn
 * `contentionMs` of synchronous main-thread time per frame to model an app
 * busy with rendering / CRDT work while storage runs — under contention the
 * discriminator is `wallMs` (the worker keeps storage off the contended
 * thread); uncontended, it's `maxBlockMs` / `jankMs`.
 */
export async function measure(
  work: () => Promise<void>,
  { contentionMs = 0 }: { contentionMs?: number } = {}
): Promise<WorkloadResult> {
  let maxBlock = 0
  let jank = 0
  let frames = 0
  let running = true
  let last = performance.now()

  const tick = () => {
    if (!running) return
    const now = performance.now()
    const gap = now - last
    last = now
    frames++
    if (gap > FRAME_BUDGET_MS) {
      maxBlock = Math.max(maxBlock, gap)
      jank += gap - FRAME_BUDGET_MS
    }
    if (contentionMs > 0) {
      const end = performance.now() + contentionMs
      while (performance.now() < end) {
        /* burn synchronous main-thread time */
      }
    }
    requestAnimationFrame(tick)
  }

  await raf() // establish a baseline frame cadence
  last = performance.now()
  requestAnimationFrame(tick)

  const start = performance.now()
  await work()
  const wallMs = performance.now() - start
  running = false
  return { wallMs, maxBlockMs: maxBlock, jankMs: jank, frames }
}
