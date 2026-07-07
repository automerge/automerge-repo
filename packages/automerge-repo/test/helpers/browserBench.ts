/**
 * Helpers for real-browser benches (mirrors
 * `automerge-repo-storage-indexeddb/test/_bench-helpers.ts`).
 *
 * Not a test file — the browser config only includes `*.browser.test.ts`.
 */

export interface WorkloadResult {
  /** Wall-clock time (includes off-thread work). */
  wallMs: number
  /** Time the main thread was busy (not idle awaiting off-thread work). */
  mainThreadMs: number
  /** Longest single main-thread block. */
  maxBlockMs: number
}

/** Gaps below this (ms) are scheduler latency, not main-thread work. */
const IDLE_NOISE_MS = 1.5

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
 * Run `work()` while metering main-thread occupancy: a `MessageChannel` posts
 * to itself back-to-back, so any gap between ticks is time the main thread was
 * busy. `contentionMs` optionally burns that many ms per frame to model an app
 * busy alongside the workload.
 */
export async function measure(
  work: () => Promise<void>,
  { contentionMs = 0 }: { contentionMs?: number } = {}
): Promise<WorkloadResult> {
  const channel = new MessageChannel()
  let last = performance.now()
  let mainThreadMs = 0
  let maxBlockMs = 0
  let running = true

  channel.port1.onmessage = () => {
    const now = performance.now()
    const gap = now - last
    last = now
    if (gap > IDLE_NOISE_MS) {
      mainThreadMs += gap
      if (gap > maxBlockMs) maxBlockMs = gap
    }
    if (running) channel.port2.postMessage(0)
  }
  channel.port2.postMessage(0)

  if (contentionMs > 0) {
    const burn = () => {
      if (!running) return
      const end = performance.now() + contentionMs
      while (performance.now() < end) {
        /* burn synchronous main-thread time */
      }
      requestAnimationFrame(burn)
    }
    requestAnimationFrame(burn)
  }

  await raf() // let the meter settle before resetting
  last = performance.now()
  mainThreadMs = 0
  maxBlockMs = 0

  const start = performance.now()
  await work()
  const wallMs = performance.now() - start
  running = false

  return {
    wallMs: Math.round(wallMs),
    mainThreadMs: Math.round(mainThreadMs),
    maxBlockMs: Math.round(maxBlockMs),
  }
}
