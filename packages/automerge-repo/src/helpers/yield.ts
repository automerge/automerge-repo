/**
 * Cooperative yielding so long runs of synchronous CRDT work don't
 * monopolize the single thread.
 *
 * The sync source does bursts of synchronous **Automerge-core Wasm** calls
 * (bulk `attach`/recompute, `loadIncremental` materialize, and save-prep
 * `getFragmentMetadata`/`bundleFragmentMetadata`). The subduction layer's own
 * heavy calls (`getBlobs`/`addBatch`/`syncWithAllPeers`) are async/I-O and
 * already yield — they are not the culprit; only Automerge-core's Wasm work
 * monopolizes the thread. Even though the surrounding code is `async`, the
 * `await`s between those synchronous calls settle as microtasks, so the host
 * never reaches the macrotask phase — timers AND the transport (the
 * WebSocket where Subduction reads sync messages and flushes keepalive
 * pongs). The thread is held for seconds: in Node the server misses pongs
 * and reaps the connection (`request timed out`); in a browser service
 * worker the socket and rendering starve.
 *
 * `yieldToMacrotask()` forces a real macrotask boundary using the best
 * primitive the host offers:
 *   - `setImmediate` (Node) — fires in the `check` phase, right after
 *     `poll`, so socket I/O ran in this same loop turn.
 *   - `MessageChannel` (browser) — a macrotask with no `setTimeout` 4ms
 *     clamp.
 *   - `setTimeout(0)` — universal fallback.
 */

const now: () => number =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now()
    : () => Date.now()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any

const scheduleMacrotask: (cb: () => void) => void = (() => {
  if (typeof g.setImmediate === "function") {
    return (cb: () => void) => {
      g.setImmediate(cb)
    }
  }
  if (typeof g.MessageChannel === "function") {
    // Reuse one channel; queue resolvers so we don't allocate per yield.
    const channel = new g.MessageChannel()
    const queue: Array<() => void> = []
    channel.port1.onmessage = () => {
      queue.shift()?.()
    }
    return (cb: () => void) => {
      queue.push(cb)
      channel.port2.postMessage(null)
    }
  }
  return (cb: () => void) => {
    g.setTimeout(cb, 0)
  }
})()

/** Resolve on the next macrotask turn, letting the host service I/O. */
export function yieldToMacrotask(): Promise<void> {
  return new Promise(resolve => scheduleMacrotask(resolve))
}

/**
 * Make a time-budgeted yielder. Call the returned function frequently in
 * a hot loop; it only actually yields once more than `budgetMs` has
 * elapsed since the last yield, so the cost is independent of per-item
 * work size (per-item CRDT cost varies 100×, so a fixed count mis-tunes).
 */
export function makeYielder(budgetMs = 50): () => Promise<void> {
  let last = now()
  return async () => {
    if (now() - last >= budgetMs) {
      await yieldToMacrotask()
      last = now()
    }
  }
}
