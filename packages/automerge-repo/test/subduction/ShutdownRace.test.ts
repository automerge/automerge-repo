/**
 * Regression: inbound dispatch must not hit a closed storage adapter
 * during `Repo.shutdown()`.
 *
 * The Wasm side can dispatch an already-received frame after
 * `disconnectAll()` resolves; if that dispatch reaches storage once
 * `StorageSubsystem.close()` has run, adapters like LMDB throw
 * "Can not read from a closed database". `SubductionSource.shutdown()`
 * closes and drains the storage bridge first, so such stragglers must
 * resolve as no-ops — never an ERROR log or unhandled rejection.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { once } from "events"
import { WebSocketServer } from "ws"

import {
  MemorySigner,
  MemoryStorage,
  Subduction,
} from "@automerge/automerge-subduction"
import { parseAutomergeUrl, generateAutomergeUrl } from "../../src/index.js"
import { resetLoggerFactory, setLoggerFactory } from "../../src/Logger.js"
import { Repo } from "../../src/Repo.js"
import { DummyStorageAdapter } from "../../src/helpers/DummyStorageAdapter.js"
import { initSubduction } from "../../src/initSubduction.js"
import { toSedimentreeId } from "../../src/subduction/helpers.js"
import { SubductionStorageBridge } from "../../src/subduction/storage.js"
import { WebSocketTransport } from "../../src/subduction/websocket-transport.js"
import type { StorageAdapterInterface } from "../../src/storage/StorageAdapterInterface.js"
import type { Chunk, StorageKey } from "../../src/storage/types.js"
import type { PeerId } from "../../src/types.js"
import { waitFor } from "../helpers/waitFor.js"

beforeAll(async () => {
  await initSubduction()
})

/**
 * LMDB-like adapter: after `close()`, every operation throws the way
 * `lmdb`'s invalidated env does, and records the attempt in
 * `opsAfterClose`. Optionally delays reads to widen the in-flight
 * window deterministically.
 */
class ClosableStorageAdapter implements StorageAdapterInterface {
  readonly inner = new DummyStorageAdapter()
  closed = false
  /** Artificial latency applied to loadRange, in ms. */
  readDelayMs = 0
  /** Count of loadRange calls that ran to completion. */
  completedReads = 0
  /**
   * Operations that reached the adapter after close(). The invariant
   * under test is that this stays empty — asserting on it is
   * independent of which logging channel a post-close error would
   * otherwise surface through.
   */
  readonly opsAfterClose: string[] = []

  #check(op: string) {
    if (this.closed) {
      this.opsAfterClose.push(op)
      throw new Error("Can not read from a closed database")
    }
  }

  async load(key: StorageKey) {
    this.#check("load")
    return this.inner.load(key)
  }

  async save(key: StorageKey, data: Uint8Array) {
    this.#check("save")
    return this.inner.save(key, data)
  }

  async remove(key: StorageKey) {
    this.#check("remove")
    return this.inner.remove(key)
  }

  async loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    this.#check("loadRange")
    if (this.readDelayMs > 0) {
      await new Promise(r => setTimeout(r, this.readDelayMs))
      this.#check("loadRange")
    }
    const result = await this.inner.loadRange(keyPrefix)
    this.completedReads++
    return result
  }

  async removeRange(keyPrefix: StorageKey) {
    this.#check("removeRange")
    return this.inner.removeRange(keyPrefix)
  }

  async saveBatch(entries: Array<[StorageKey, Uint8Array]>) {
    this.#check("saveBatch")
    return this.inner.saveBatch(entries)
  }

  close() {
    this.closed = true
  }
}

// A valid random document id, without constructing a Repo (a module-scope
// Repo would eagerly build SubductionSource state before beforeAll runs).
const SID = toSedimentreeId(
  parseAutomergeUrl(generateAutomergeUrl()).documentId
)

describe("SubductionStorageBridge close guard", () => {
  it("short-circuits reads and writes after close()", async () => {
    const adapter = new ClosableStorageAdapter()
    const bridge = new SubductionStorageBridge(adapter)

    await bridge.saveSedimentreeId(SID)
    expect(await bridge.loadAllSedimentreeIds()).toHaveLength(1)

    bridge.close()
    adapter.close()
    expect(bridge.isClosed).toBe(true)

    // Reads return empty; writes no-op — despite the adapter now throwing.
    await expect(bridge.loadAllCommits(SID)).resolves.toEqual([])
    await expect(bridge.loadAllFragments(SID)).resolves.toEqual([])
    await expect(bridge.loadAllSedimentreeIds()).resolves.toEqual([])
    await expect(bridge.listCommitIds(SID)).resolves.toEqual([])
    await expect(bridge.listFragmentIds(SID)).resolves.toEqual([])
    await expect(bridge.loadRemoteHeads(SID)).resolves.toEqual([])
    await expect(bridge.loadBlobById(SID, "00")).resolves.toBeNull()
    await expect(bridge.saveSedimentreeId(SID)).resolves.toBeUndefined()
    await expect(bridge.deleteAllCommits(SID)).resolves.toBeUndefined()
    await expect(
      bridge.saveRemoteHeads(SID, "storage-id", [], Date.now())
    ).resolves.toBeUndefined()

    // Nothing above reached the adapter.
    expect(adapter.opsAfterClose).toEqual([])
  })

  it("counts dropped writes and keeps pending accounting balanced", async () => {
    const adapter = new ClosableStorageAdapter()
    const bridge = new SubductionStorageBridge(adapter)

    bridge.close()
    expect(bridge.droppedWrites).toBe(0)

    // Post-close writes: no adapter access, no events, counted.
    let commitEvents = 0
    bridge.on("commit-saved", () => {
      commitEvents++
    })
    await expect(bridge.saveBatchAll(SID, [], [])).resolves.toBe(0)
    await expect(bridge.saveSedimentreeId(SID)).resolves.toBeUndefined()

    expect(bridge.droppedWrites).toBe(2)
    expect(commitEvents).toBe(0)
    expect(adapter.opsAfterClose).toEqual([])
    // The pending counters stayed balanced through the fallback path.
    await expect(bridge.awaitSettled()).resolves.toBeUndefined()
    // Dropped reads are benign and not counted.
    await bridge.loadAllCommits(SID)
    expect(bridge.droppedWrites).toBe(2)
  })

  it("propagates adapter errors while the bridge is open", async () => {
    const adapter = new ClosableStorageAdapter()
    const bridge = new SubductionStorageBridge(adapter)

    // Close the adapter but NOT the bridge: a genuine storage failure on
    // an open bridge (corruption, disk full) must surface, not be
    // swallowed by the close guard.
    adapter.close()

    await expect(bridge.loadAllCommits(SID)).rejects.toThrow(
      /closed database/i
    )
    await expect(bridge.saveSedimentreeId(SID)).rejects.toThrow(
      /closed database/i
    )
  })

  it("awaitIdle() drains an in-flight read before resolving", async () => {
    const adapter = new ClosableStorageAdapter()
    adapter.readDelayMs = 50
    const bridge = new SubductionStorageBridge(adapter)

    const inFlight = bridge.loadAllCommits(SID)

    bridge.close()
    expect(adapter.completedReads).toBe(0)
    await bridge.awaitIdle()
    // Every adapter read that passed the guard finished before awaitIdle
    // resolved — the adapter is safe to close now.
    const drained = adapter.completedReads
    expect(drained).toBeGreaterThan(0)
    await inFlight
    expect(adapter.completedReads).toBe(drained)
  })

  it("swallows an adapter error from a read that raced close()", async () => {
    const adapter = new ClosableStorageAdapter()
    adapter.readDelayMs = 50
    const bridge = new SubductionStorageBridge(adapter)

    // Passes the guard while open, then the adapter closes underneath it —
    // the post-delay #check() throws, mimicking LMDB invalidating the env
    // mid-operation. The bridge must absorb it once closed.
    const inFlight = bridge.loadAllCommits(SID)
    bridge.close()
    adapter.close()

    await expect(inFlight).resolves.toEqual([])
  })
})

describe("Repo.shutdown() with a close-on-shutdown adapter", () => {
  const cleanups: Array<() => Promise<void>> = []
  const errorLogs: string[] = []
  const rejections: unknown[] = []
  const onRejection = (reason: unknown) => rejections.push(reason)

  beforeAll(() => {
    setLoggerFactory(namespace => ({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (message, ...args) => {
        errorLogs.push(`[${namespace}] ${message} ${args.join(" ")}`)
      },
    }))
  })

  afterAll(() => {
    resetLoggerFactory()
  })

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) {
      await cleanup()
    }
    cleanups.length = 0
    errorLogs.length = 0
    rejections.length = 0
  })

  async function startSubductionServer(): Promise<{
    url: string
    subduction: Subduction
    close(): Promise<void>
  }> {
    const signer = new MemorySigner()
    const storage = new MemoryStorage()
    const subduction = new Subduction({ signer, storage })

    const wss = new WebSocketServer({ port: 0 })
    await once(wss, "listening")

    const address = wss.address()
    if (address === null || typeof address === "string")
      throw new Error("unexpected address type")
    const url = `ws://localhost:${address.port}`
    const serviceName = `localhost:${address.port}`

    wss.on("connection", ws => {
      const transport = new WebSocketTransport(ws as any)
      subduction
        .acceptTransport(transport, serviceName)
        .catch(e => console.error("acceptTransport failed:", e))
    })

    return {
      url,
      subduction,
      async close() {
        await subduction.disconnectAll()
        await new Promise<void>((resolve, reject) =>
          wss.close(err => (err ? reject(err) : resolve()))
        )
      },
    }
  }

  it("produces no closed-database errors when shutdown races inbound sync", async () => {
    process.on("unhandledRejection", onRejection)
    cleanups.push(async () => {
      process.off("unhandledRejection", onRejection)
    })

    const server = await startSubductionServer()
    cleanups.push(() => server.close())

    // Writer publishes a doc through the server.
    const writerAdapter = new ClosableStorageAdapter()
    const writer = new Repo({
      peerId: "writer" as PeerId,
      storage: writerAdapter,
      subductionWebsocketEndpoints: [server.url],
    })
    const handle = writer.create<{ count: number }>()
    handle.change(d => {
      d.count = 0
    })

    const sid = toSedimentreeId(handle.documentId)
    await waitFor(async () => {
      const blobs = await server.subduction.getBlobs(sid)
      expect(blobs?.length ?? 0).toBeGreaterThan(0)
    }, 5000)

    // Reader attaches the same doc, then shuts down while sync frames
    // for a burst of fresh changes are still inbound — the window where
    // a late dispatch could hit closed storage. Slow reads widen the
    // in-flight overlap.
    const readerAdapter = new ClosableStorageAdapter()
    readerAdapter.readDelayMs = 5
    const reader = new Repo({
      peerId: "reader" as PeerId,
      storage: readerAdapter,
      subductionWebsocketEndpoints: [server.url],
    })
    const fetched = await reader.find<{ count: number }>(handle.url)
    expect(fetched.doc()?.count).toBe(0)

    for (let i = 1; i <= 25; i++) {
      handle.change(d => {
        d.count = i
      })
    }

    // No settling wait: shut down with traffic in flight.
    await reader.shutdown()
    expect(readerAdapter.closed).toBe(true)

    await writer.shutdown()
    expect(writerAdapter.closed).toBe(true)

    // Give any straggler dispatches a few macrotasks to surface.
    await new Promise(r => setTimeout(r, 100))

    // The core invariant, independent of logging channels: nothing
    // touched either adapter after it closed.
    expect(readerAdapter.opsAfterClose).toEqual([])
    expect(writerAdapter.opsAfterClose).toEqual([])

    const closedDbErrors = [...errorLogs, ...rejections.map(String)].filter(
      line => /closed database/i.test(String(line))
    )
    expect(closedDbErrors).toEqual([])
    expect(rejections).toEqual([])
  })
})
