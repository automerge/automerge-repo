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
    addEventListener(type: string, listener: (event?: never) => void) {
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
