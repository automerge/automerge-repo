/**
 * Gated real-browser bench: `WebSocketTransport` (socket on the main thread)
 * vs `WorkerWebSocketTransport` (socket in a Worker). Skipped unless
 * `WS_BENCH=1`:
 *
 *   WS_BENCH=1 pnpm --filter @automerge/automerge-repo test:browser
 *
 * Workloads (per variant, median of WS_BENCH_REPEATS):
 *
 * - "throughput": pipeline WS_BENCH_MSGS echo roundtrips of WS_BENCH_BLOB
 *   bytes. The worker hop adds a postMessage per direction, so expect the
 *   worker variant to trade some wall time...
 * - "contention": same, while a synthetic app burns WS_BENCH_CONTENTION_MS
 *   of main-thread time per frame. mainThreadMs / maxBlockMs are the numbers
 *   topology A exists for: socket parsing/buffering happens off-thread.
 *
 * Knobs: WS_BENCH_MSGS, WS_BENCH_BLOB, WS_BENCH_REPEATS,
 * WS_BENCH_CONTENTION_MS, TEST_BROWSERS.
 */
import { commands } from "vitest/browser"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { WebSocketTransport } from "../../src/subduction/websocket-transport.js"
import { WorkerWebSocketEndpoint } from "../../src/subduction/websocket-endpoint.js"
import type { ManagedTransport } from "../../src/subduction/websocket-endpoint.js"
import {
  measure,
  median,
  randomBytes,
  type WorkloadResult,
} from "../helpers/browserBench.js"

declare const __WS_BENCH__: string
declare const __WS_BENCH_MSGS__: string
declare const __WS_BENCH_BLOB__: string
declare const __WS_BENCH_REPEATS__: string
declare const __WS_BENCH_CONTENTION_MS__: string

const ENABLED = __WS_BENCH__ === "1"
const MSGS = Number.parseInt(__WS_BENCH_MSGS__, 10)
const BLOB = Number.parseInt(__WS_BENCH_BLOB__, 10)
const REPEATS = Number.parseInt(__WS_BENCH_REPEATS__, 10)
const CONTENTION_MS = Number.parseInt(__WS_BENCH_CONTENTION_MS__, 10)

interface Variant {
  label: string
  connect: (url: string) => Promise<ManagedTransport>
  cleanup?: () => void
}

const summarize = (label: string, runs: WorkloadResult[]) => ({
  variant: label,
  wallMs: Math.round(median(runs.map(r => r.wallMs))),
  mainThreadMs: Math.round(median(runs.map(r => r.mainThreadMs))),
  maxBlockMs: Math.round(median(runs.map(r => r.maxBlockMs))),
})

type Summary = ReturnType<typeof summarize>

describe.skipIf(!ENABLED)("WebSocket transport bench (real browser)", () => {
  let port: number
  let url: string

  beforeAll(async () => {
    const started = await commands.startEchoServer()
    port = started.port
    url = `ws://localhost:${port}`
  })

  afterAll(async () => {
    await commands.stopEchoServer(port)
  })

  const makeVariants = (): Variant[] => {
    const endpoint = () => {
      const ep = new WorkerWebSocketEndpoint(url)
      return ep
    }
    let workerEndpoint: WorkerWebSocketEndpoint | null = null
    return [
      {
        label: "in-thread",
        connect: (u: string) => WebSocketTransport.connect(u),
      },
      {
        label: "worker",
        connect: () => {
          workerEndpoint ??= endpoint()
          return workerEndpoint.connect()
        },
        cleanup: () => workerEndpoint?.shutdown(),
      },
    ]
  }

  /** Pipeline MSGS echo roundtrips of BLOB bytes through one transport. */
  const pump = async (transport: ManagedTransport, payload: Uint8Array) => {
    for (let i = 0; i < MSGS; i++) {
      void transport.sendBytes(payload)
    }
    for (let i = 0; i < MSGS; i++) {
      const echoed = await transport.recvBytes()
      if (echoed.length !== payload.length) {
        throw new Error(
          `echo length mismatch: ${echoed.length} != ${payload.length}`
        )
      }
    }
  }

  const runVariants = async (contentionMs: number): Promise<Summary[]> => {
    const payload = randomBytes(BLOB)
    const summaries: Summary[] = []

    for (const variant of makeVariants()) {
      const runs: WorkloadResult[] = []
      for (let i = 0; i < REPEATS; i++) {
        const transport = await variant.connect(url)
        runs.push(
          await measure(() => pump(transport, payload), { contentionMs })
        )
        await transport.disconnect()
      }
      variant.cleanup?.()
      summaries.push(summarize(variant.label, runs))
    }

    return summaries
  }

  it(`throughput: ${MSGS} × ${BLOB}B echo roundtrips`, async () => {
    const summaries = await runVariants(0)

    await commands.reportBench(
      `throughput: ${MSGS} × ${BLOB}B echo roundtrips (median of ${REPEATS})`,
      summaries
    )

    for (const s of summaries) expect(s.wallMs).toBeGreaterThan(0)
  })

  it(`contention: same, with ${CONTENTION_MS}ms/frame of app work`, async () => {
    const summaries = await runVariants(CONTENTION_MS)

    await commands.reportBench(
      `contention: ${MSGS} × ${BLOB}B with ${CONTENTION_MS}ms/frame app work (median of ${REPEATS})`,
      summaries
    )

    for (const s of summaries) expect(s.wallMs).toBeGreaterThan(0)
  })
})
