/**
 * The SharedWorker-donated-port scenario: one MessagePort carrying both
 * the storage RPC host and the Subduction WebSocket proxy host (channel
 * tags keep them disjoint), plus adapter recovery when a provider hands
 * out a replacement port after the io worker dies.
 */
import "fake-indexeddb/auto"
import { MessageChannel as NodeMessageChannel } from "node:worker_threads"
import { afterEach, describe, expect, it } from "vitest"

import {
  WorkerWebSocketTransport,
  attachWebSocketHost,
  type WebSocketLike,
  type WorkerPortLike,
} from "@automerge/automerge-repo/slim"

import {
  IndexedDBWorkerStorageAdapter,
  WorkerStorageError,
} from "../src/IndexedDBWorkerStorageAdapter.js"
import { attachStorageHost } from "../src/worker-host.js"
import {
  STORAGE_RPC,
  STORAGE_RPC_PROTOCOL_VERSION,
  type StorageRpcRequest,
} from "../src/worker-rpc.js"

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

const openPorts: Array<{ close(): void }> = []
const detachers: Array<() => void> = []
const adapters: IndexedDBWorkerStorageAdapter[] = []

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.close()
  for (const detach of detachers.splice(0)) detach()
  for (const port of openPorts.splice(0)) port.close()
})

/** Echo socket that opens on the next microtask. */
const makeEchoSocket = (): WebSocketLike => {
  const listeners = new Map<string, Array<(event?: unknown) => void>>()
  const emit = (type: string, event?: unknown) => {
    for (const l of listeners.get(type) ?? []) l(event as never)
  }
  queueMicrotask(() => emit("open"))
  return {
    binaryType: "",
    send(data: Uint8Array) {
      emit("message", { data: data.slice().buffer })
    },
    close() {
      emit("close")
    },
    addEventListener(type: string, listener: (event: never) => void) {
      const list = listeners.get(type) ?? []
      list.push(listener as (event?: unknown) => void)
      listeners.set(type, list)
    },
  }
}

/** An "io worker" hosting storage + websocket proxying on one port. */
const makeIoPort = (): WorkerPortLike => {
  const channel = new NodeMessageChannel()
  openPorts.push(channel.port1, channel.port2)
  const hostSide = channel.port2 as unknown as WorkerPortLike
  detachers.push(attachStorageHost(hostSide))
  detachers.push(
    attachWebSocketHost(hostSide, { createSocket: makeEchoSocket })
  )
  return channel.port1 as unknown as WorkerPortLike
}

describe("storage + websocket hosts sharing one donated port", () => {
  it("serves both protocols without cross-talk", async () => {
    const port = makeIoPort()

    const adapter = new IndexedDBWorkerStorageAdapter(
      "shared-port-db",
      "documents",
      port
    )
    adapters.push(adapter)

    const transport = await WorkerWebSocketTransport.connect(
      port,
      "ws://unused.example"
    )

    // Interleave traffic on the same port.
    const payload = new Uint8Array([1, 2, 3, 4])
    await adapter.save(["doc", "chunk"], payload)
    await transport.sendBytes(new Uint8Array([9, 9]))
    expect(await adapter.load(["doc", "chunk"])).toStrictEqual(payload)
    expect(Array.from(await transport.recvBytes())).toEqual([9, 9])

    await transport.disconnect()
  })

  it("recovers storage through a provider after the port dies", async () => {
    const live: WorkerPortLike[] = []
    let fetches = 0
    const adapter = new IndexedDBWorkerStorageAdapter(
      "provider-recovery-db",
      "documents",
      () => {
        fetches++
        const port = makeIoPort()
        live.push(port)
        return port
      }
    )
    adapters.push(adapter)

    await adapter.save(["k"], new Uint8Array([7]))
    expect(fetches).toBe(1)

    // io worker crashes: in-flight calls reject...
    const inflight = adapter.load(["k"])
    ;(live[0] as unknown as { close(): void }).close()
    await expect(inflight).rejects.toBeInstanceOf(WorkerStorageError)
    await tick()

    // ...but the next call re-invokes the provider and heals (the data
    // survives because fake-indexeddb state is process-global here, as
    // IndexedDB state is browser-global across worker restarts).
    expect(await adapter.load(["k"])).toStrictEqual(new Uint8Array([7]))
    expect(fetches).toBe(2)
  })

  it("concurrent first calls share one provider fetch", async () => {
    let fetches = 0
    const adapter = new IndexedDBWorkerStorageAdapter(
      "single-flight-db",
      "documents",
      () => {
        fetches++
        return makeIoPort()
      }
    )
    adapters.push(adapter)

    // Fire a burst before any port exists; all must share one fetch.
    await Promise.all([
      adapter.save(["a"], new Uint8Array([1])),
      adapter.save(["b"], new Uint8Array([2])),
      adapter.loadRange([]),
    ])
    expect(fetches).toBe(1)
    expect(await adapter.load(["a"])).toStrictEqual(new Uint8Array([1]))
    expect(fetches).toBe(1)
  })

  it("heals through a provider after a non-timeout init failure", async () => {
    /** A port whose far side answers `init` with an error. */
    const makeInitRejectingPort = (): WorkerPortLike => {
      const channel = new NodeMessageChannel()
      openPorts.push(channel.port1, channel.port2)
      const host = channel.port2 as unknown as WorkerPortLike
      host.addEventListener("message", event => {
        const msg = (event as MessageEvent).data as StorageRpcRequest
        if (msg?.channel !== STORAGE_RPC) return
        host.postMessage({
          channel: STORAGE_RPC,
          v: STORAGE_RPC_PROTOCOL_VERSION,
          client: msg.client,
          id: msg.id,
          ok: false,
          error: "induced init failure",
        })
      })
      host.start?.()
      return channel.port1 as unknown as WorkerPortLike
    }

    let fetches = 0
    const adapter = new IndexedDBWorkerStorageAdapter(
      "init-failure-db",
      "documents",
      () => {
        fetches++
        return fetches === 1 ? makeInitRejectingPort() : makeIoPort()
      }
    )
    adapters.push(adapter)

    // First call fails at init — but must not cache the rejection.
    await expect(adapter.save(["k"], new Uint8Array([1]))).rejects.toThrow(
      "induced init failure"
    )

    // Next call re-invokes the provider and succeeds on the fresh port.
    await adapter.save(["k"], new Uint8Array([2]))
    expect(fetches).toBe(2)
    expect(await adapter.load(["k"])).toStrictEqual(new Uint8Array([2]))
  })

  it("evicts a port whose postMessage throws, healing via the provider", async () => {
    // A synchronously broken port: postMessage always throws and no
    // close event will ever fire.
    const throwingPort: WorkerPortLike = {
      postMessage() {
        throw new Error("detached port")
      },
      addEventListener() {},
      removeEventListener() {},
    }

    let fetches = 0
    const adapter = new IndexedDBWorkerStorageAdapter(
      "sync-throw-db",
      "documents",
      () => {
        fetches++
        return fetches === 1 ? throwingPort : makeIoPort()
      }
    )
    adapters.push(adapter)

    // First call fails — and must evict the broken port, not cache it.
    await expect(adapter.save(["k"], new Uint8Array([1]))).rejects.toThrow(
      "detached port"
    )

    // Next call re-invokes the provider and succeeds on the fresh port.
    await adapter.save(["k"], new Uint8Array([2]))
    expect(fetches).toBe(2)
    expect(await adapter.load(["k"])).toStrictEqual(new Uint8Array([2]))
  })

  it("fails loudly against a stale (untagged) storage worker", async () => {
    // An "old build" host: answers init ok, but without a version tag.
    const channel = new NodeMessageChannel()
    openPorts.push(channel.port1, channel.port2)
    channel.port2.on(
      "message",
      (msg: { channel?: string; client?: string; id?: number }) => {
        if (msg?.channel !== STORAGE_RPC) return
        channel.port2.postMessage({
          channel: STORAGE_RPC,
          client: msg.client,
          id: msg.id,
          ok: true,
          result: undefined,
        })
      }
    )

    const adapter = new IndexedDBWorkerStorageAdapter(
      "skew-db",
      "documents",
      channel.port1 as unknown as WorkerPortLike
    )
    adapters.push(adapter)

    const failure = await adapter
      .save(["k"], new Uint8Array([1]))
      .catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(WorkerStorageError)
    expect((failure as Error).message).toMatch(/version mismatch/)
  })

  it("a fixed donated port stays terminal after death (no provider)", async () => {
    const port = makeIoPort()
    const adapter = new IndexedDBWorkerStorageAdapter(
      "fixed-port-db",
      "documents",
      port
    )
    adapters.push(adapter)

    await adapter.save(["k"], new Uint8Array([1]))
    ;(port as unknown as { close(): void }).close()
    await tick()

    await expect(adapter.load(["k"])).rejects.toBeInstanceOf(
      WorkerStorageError
    )
  })
})
