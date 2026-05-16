/**
 * Regression tests for `SubductionSource.shutdown()` quiescence
 * timing.
 *
 * The original shutdown sequence awaited every entry's `saveSettled`
 * BEFORE disconnecting the underlying Wasm transports. When two
 * peers shut down concurrently and one has a throttled `flushSave`
 * pending, that side fires `subduction.addBatch(...)` from step 3
 * and then sits in step 4 `await saveSettled` waiting for the
 * remote to ack. The remote, meanwhile, has nothing pending and
 * runs straight through step 6 (`subduction.disconnectAll()`),
 * tearing down ITS Wasm transports. The first side's `addBatch`
 * is now pushing into a void — but its OWN transport is still
 * alive (step 6 hadn't run yet), and `subduction_core` does not
 * propagate the remote tear-down back into the in-flight
 * `RequestId`. The request only resolves when the Rust-side
 * per-request timeout fires (~30s), at which point `addBatch`
 * resolves successfully (with a stderr `ERROR ... timed out`,
 * but the JS promise itself does NOT reject) and `saveSettled`
 * finally resolves.
 *
 * The fix is two-part:
 *
 *   1. `SubductionSource.shutdown()`: call `disconnectAll()`
 *      BEFORE `await saveSettled`. Tearing down our OWN transport
 *      synchronously rejects any in-flight local `addBatch`
 *      (the request is local to our `subduction_core` —
 *      killing our transport kills the request), so
 *      `saveSettled` resolves in single-digit milliseconds.
 *
 *   2. `NetworkAdapterTransport.#teardown` (in `network.ts`):
 *      reject any pending `recvBytes` waiters so the local
 *      Wasm-side `addBatch` fails fast when its OWN transport
 *      is torn down via the `peer-disconnected` event from the
 *      underlying adapter.
 *
 * Without either fix this test hits the Rust-side ~30s per-request
 * timeout; with both fixes it completes in single-digit ms.
 *
 * Topology: a single subduction WebSocket server + two clients.
 * Both clients shut down concurrently while one has a pending
 * write (the server stays running and does not participate in
 * the concurrent-close path).
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { WebSocketServer } from "ws"

import { WebSocketClientAdapter } from "../../../automerge-repo-network-websocket/src/WebSocketClientAdapter.js"
import { WebSocketServerAdapter } from "../../../automerge-repo-network-websocket/src/WebSocketServerAdapter.js"
import { Repo } from "../../src/Repo.js"
import { DummyStorageAdapter } from "../../src/helpers/DummyStorageAdapter.js"
import { initSubduction } from "../../src/initSubduction.js"
import { pause } from "../../src/helpers/pause.js"
import type { PeerId } from "../../src/types.js"

beforeAll(async () => {
  await initSubduction()
})

const SHUTDOWN_BUDGET_MS = 2_000

/** Race a promise against a wall-clock budget. */
const withinBudget = async <T>(p: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`exceeded ${ms}ms wall-clock budget`)),
      ms
    )
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Poll until `fn` returns truthy or the budget expires. */
const waitForCondition = async (
  fn: () => Promise<boolean> | boolean,
  ms: number,
  intervalMs = 25
): Promise<void> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await fn()) return
    await pause(intervalMs)
  }
  throw new Error(`waitForCondition timed out after ${ms}ms`)
}

/**
 * Stand up a peer-to-peer subduction topology over a single
 * `WebSocketServer` + one `WebSocketClientAdapter`:
 *
 *   acceptRepo (role: "accept")  ◀── ws ──▶  connectRepo (role: "connect")
 *
 * Unlike the `AdapterTopology` server+clients setup, both endpoints
 * here are full peers exchanging subduction frames directly. That is
 * what reproduces the concurrent-shutdown bug: the in-flight
 * `addBatch` from one peer is targeted at the OTHER peer that is
 * also shutting down, not at a long-running relay server.
 */
interface PeerPairEnv {
  acceptRepo: Repo
  connectRepo: Repo
  /** Tear down the underlying WebSocket pair without touching repos. */
  cutWire: () => Promise<void>
}

async function makePeerPair(): Promise<PeerPairEnv> {
  // Grab an ephemeral port.
  const tmp = new WebSocketServer({ port: 0 })
  await new Promise<void>(r => tmp.on("listening", r))
  const addr = tmp.address()
  if (typeof addr === "string") throw new Error("unexpected address type")
  const port = addr.port
  await new Promise<void>((r, e) => tmp.close(err => (err ? e(err) : r())))

  const wss = new WebSocketServer({ port })
  await new Promise<void>(r => wss.on("listening", r))
  const serviceName = `localhost:${port}`

  // accept-side: server adapter wrapping the WebSocketServer.
  const serverAdapter = new WebSocketServerAdapter(wss)
  const acceptRepo = new Repo({
    peerId: "accept" as PeerId,
    storage: new DummyStorageAdapter(),
    network: [],
    subductionAdapters: [
      { adapter: serverAdapter, serviceName, role: "accept" },
    ],
    sharePolicy: async () => true,
  })

  // connect-side: client adapter dialing the server.
  const clientAdapter = new WebSocketClientAdapter(`ws://localhost:${port}`)
  const connectRepo = new Repo({
    peerId: "connect" as PeerId,
    storage: new DummyStorageAdapter(),
    network: [],
    subductionAdapters: [{ adapter: clientAdapter, serviceName }],
    sharePolicy: async () => true,
  })

  return {
    acceptRepo,
    connectRepo,
    cutWire: async () => {
      try {
        clientAdapter.disconnect()
      } catch {}
      try {
        serverAdapter.disconnect()
      } catch {}
      await new Promise<void>(r => wss.close(() => r()))
    },
  }
}

describe("SubductionSource.shutdown quiescence", () => {
  const cleanups: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup()
      } catch {
        // best-effort
      }
    }
    cleanups.length = 0
  })

  it("concurrent shutdown completes quickly when one peer has an in-flight push", async () => {
    const env = await makePeerPair()
    // Belt-and-braces: bound the cleanup shutdown so a regression
    // doesn't hang the runner for ~30s, and force-tear the WebSocket
    // pair so any stuck `recvBytes` on the Wasm side gets a chance
    // to reject (or at least so the runner doesn't keep the
    // sockets pinned open).
    cleanups.push(async () => {
      await withinBudget(
        Promise.all([env.acceptRepo.shutdown(), env.connectRepo.shutdown()]),
        SHUTDOWN_BUDGET_MS
      ).catch(() => {})
      await env.cutWire()
    })

    // Give the WebSocket pair time to establish.
    await pause(500)

    // GIVEN: the connect-side peer creates a doc and the accept-side
    // peer syncs it.
    const connectHandle = env.connectRepo.create<{ text?: string }>()
    connectHandle.change(d => {
      d.text = "initial"
    })

    const acceptProgress = env.acceptRepo.findWithProgress<{
      text?: string
    }>(connectHandle.url)
    await waitForCondition(() => {
      const s = acceptProgress.peek()
      return s.state === "ready" && s.handle.doc()?.text === "initial"
    }, 5_000)
    // Make sure subduction has actually flushed before we proceed.
    await pause(300)

    // Kick a fresh save on the connect side right before concurrent
    // shutdown so an `addBatch` is in flight when both peers reach
    // `SubductionSource.shutdown()` step 4. Without this the
    // throttled save may have already settled before shutdown starts
    // and the bug doesn't reproduce.
    connectHandle.change(d => {
      d.text = "pre-close write"
    })

    // THEN: concurrent shutdown of both peers completes within the
    // budget. Without the patch this would hit the ~30s Rust-side
    // per-request timeout because the in-flight `addBatch` sits
    // until that timeout fires.
    await withinBudget(
      Promise.all([env.connectRepo.shutdown(), env.acceptRepo.shutdown()]),
      SHUTDOWN_BUDGET_MS
    )

    expect(connectHandle.doc()!.text).toBe("pre-close write")
  }, 15_000)
})
