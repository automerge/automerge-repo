/**
 * Event-loop drift probe for worker contexts.
 *
 * Measures how late a periodic timer fires — a direct proxy for "how long
 * was this thread blocked by long tasks". Run inside a proxy worker it
 * answers the question *"are residual stalls caused by the worker, or by
 * the consumer thread?"*: a healthy proxy worker reports (near) zero
 * drift, so any backlog observed on the consumer side is the consumer's
 * own contention.
 *
 * Samples are only reported when drift crosses `reportThresholdMs`, so a
 * healthy worker emits nothing at all. The shipped worker entries start a
 * probe automatically and relay samples on the
 * {@link WORKER_STATS_CHANNEL} (`am-worker-stats`); listen with
 * {@link isWorkerStatsMessage}:
 *
 * ```ts
 * port.addEventListener("message", e => {
 *   if (isWorkerStatsMessage(e.data)) {
 *     console.warn(`proxy worker stalled ${e.data.driftMs}ms`)
 *   }
 * })
 * ```
 */

import {
  WORKER_PORT_PROTOCOL_VERSION,
  WORKER_STATS_CHANNEL,
  type WorkerStatsMessage,
} from "./protocol.js"

export interface DriftProbeOptions {
  /** Timer period. Default 1000 ms. */
  intervalMs?: number
  /**
   * Only report samples whose drift is at least this. Default 250 ms —
   * large enough that a healthy worker stays silent, small enough to
   * catch stalls that matter. Use 0 to report every tick (bench mode).
   */
  reportThresholdMs?: number
}

/**
 * Start a drift probe; every sample crossing the threshold is handed to
 * `report` as a {@link WorkerStatsMessage}. Returns a stop function.
 */
export function startDriftProbe(
  report: (sample: WorkerStatsMessage) => void,
  { intervalMs = 1000, reportThresholdMs = 250 }: DriftProbeOptions = {}
): () => void {
  let expected = Date.now() + intervalMs

  const timer = setInterval(() => {
    const now = Date.now()
    // Clamp at zero: timers can fire marginally early after clock nudges.
    const driftMs = Math.max(0, now - expected)
    expected = now + intervalMs

    if (driftMs >= reportThresholdMs) {
      report({
        channel: WORKER_STATS_CHANNEL,
        v: WORKER_PORT_PROTOCOL_VERSION,
        kind: "drift",
        driftMs,
        intervalMs,
        at: now,
      })
    }
  }, intervalMs)

  return () => clearInterval(timer)
}
