import "fake-indexeddb/auto"
import { afterEach, describe, expect, it } from "vitest"

import type { Chunk } from "@automerge/automerge-repo/slim"
import {
  IndexedDBWorkerStorageAdapter,
  WorkerStorageError,
} from "../src/IndexedDBWorkerStorageAdapter.js"
import { makeStorageRpcDispatcher } from "../src/worker-handler.js"
import type { StorageRpcRequest } from "../src/worker-rpc.js"

const PAYLOAD_A = () => new Uint8Array([0, 1, 127, 99, 154, 235])
const PAYLOAD_B = () => new Uint8Array([1, 76, 160, 53, 57, 10, 230])
const PAYLOAD_C = () => new Uint8Array([2, 111, 74, 131, 236, 96, 142, 193])

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

// IndexedDB returns ranges in key order, not insertion order; sort before
// comparing multi-record results so the assertions are order-insensitive.
const sortByKey = (chunks: Chunk[]) =>
  [...chunks].sort((a, b) =>
    a.key.join("\u0000").localeCompare(b.key.join("\u0000"))
  )

/** In-process Worker stand-in: runs the real dispatcher, replies async. */
class FakeStorageWorker {
  /** When true, drop outgoing replies — simulates a hung/crashed worker. */
  dropReplies = false
  #terminated = false
  #dispatch = makeStorageRpcDispatcher()
  #listeners = {
    message: new Set<(e: MessageEvent) => void>(),
    error: new Set<(e: Event) => void>(),
    messageerror: new Set<(e: Event) => void>(),
  }

  addEventListener(type: "message" | "error" | "messageerror", fn: never) {
    this.#listeners[type]?.add(fn)
  }

  removeEventListener(type: "message" | "error" | "messageerror", fn: never) {
    this.#listeners[type]?.delete(fn)
  }

  postMessage(msg: StorageRpcRequest) {
    if (this.#terminated) return
    void this.#dispatch(msg, response => {
      queueMicrotask(() => {
        if (this.#terminated || this.dropReplies) return
        for (const fn of this.#listeners.message) {
          fn({ data: response } as MessageEvent)
        }
      })
    })
  }

  terminate() {
    this.#terminated = true
  }

  /** Test helper: simulate the worker thread crashing. */
  crash(message = "worker crashed") {
    const event =
      typeof ErrorEvent !== "undefined"
        ? new ErrorEvent("error", { message })
        : ({ message } as unknown as Event)
    for (const fn of this.#listeners.error) fn(event)
  }
}

const created: IndexedDBWorkerStorageAdapter[] = []
const track = (a: IndexedDBWorkerStorageAdapter) => (created.push(a), a)
const makeAdapter = (database: string, worker = new FakeStorageWorker()) => {
  const adapter = track(
    new IndexedDBWorkerStorageAdapter(
      database,
      "documents",
      worker as unknown as Worker
    )
  )
  return { adapter, worker }
}

afterEach(() => {
  for (const a of created.splice(0)) a.dispose()
})

describe("IndexedDBWorkerStorageAdapter (worker-RPC proxy)", () => {
  it("round-trips save/load, composite keys, and large payloads", async () => {
    const { adapter } = makeAdapter("idb-fn-roundtrip")
    expect(await adapter.load(["missing"])).toBeUndefined()

    await adapter.save(["id"], PAYLOAD_A())
    expect(await adapter.load(["id"])).toStrictEqual(PAYLOAD_A())

    await adapter.save(["a", "b", "c"], PAYLOAD_B())
    expect(await adapter.load(["a", "b", "c"])).toStrictEqual(PAYLOAD_B())

    const large = new Uint8Array(100_000).map(() =>
      Math.floor(Math.random() * 256)
    )
    await adapter.save(["big"], large)
    expect(await adapter.load(["big"])).toStrictEqual(large)
  })

  it("loadRange returns all matching records and only those", async () => {
    const { adapter } = makeAdapter("idb-fn-range")
    await adapter.save(["AAAAA", "sync-state", "x"], PAYLOAD_A())
    await adapter.save(["AAAAA", "snapshot", "y"], PAYLOAD_B())
    await adapter.save(["BBBBB", "sync-state", "z"], PAYLOAD_C())

    expect(sortByKey(await adapter.loadRange(["AAAAA"]))).toStrictEqual(
      sortByKey([
        { key: ["AAAAA", "sync-state", "x"], data: PAYLOAD_A() },
        { key: ["AAAAA", "snapshot", "y"], data: PAYLOAD_B() },
      ])
    )
    expect(await adapter.loadRange(["AAAAA", "snapshot"])).toStrictEqual([
      { key: ["AAAAA", "snapshot", "y"], data: PAYLOAD_B() },
    ])
    expect(await adapter.loadRange(["ZZZ"])).toStrictEqual([])
  })

  it("overwrites data saved under the same key", async () => {
    const { adapter } = makeAdapter("idb-fn-overwrite")
    await adapter.save(["k"], PAYLOAD_A())
    await adapter.save(["k"], PAYLOAD_B())
    expect(await adapter.load(["k"])).toStrictEqual(PAYLOAD_B())
  })

  it("remove and removeRange delete the right records", async () => {
    const { adapter } = makeAdapter("idb-fn-remove")
    await adapter.save(["AAAAA", "snapshot", "x"], PAYLOAD_A())
    await adapter.save(["AAAAA", "sync-state", "y"], PAYLOAD_B())
    await adapter.save(["BBBBB", "sync-state", "z"], PAYLOAD_C())

    await adapter.remove(["AAAAA", "snapshot", "x"])
    expect(await adapter.load(["AAAAA", "snapshot", "x"])).toBeUndefined()

    await adapter.removeRange(["AAAAA"])
    expect(await adapter.loadRange(["AAAAA"])).toStrictEqual([])
    expect(await adapter.loadRange(["BBBBB"])).toStrictEqual([
      { key: ["BBBBB", "sync-state", "z"], data: PAYLOAD_C() },
    ])
  })

  it("saveBatch persists every entry", async () => {
    const { adapter } = makeAdapter("idb-fn-batch")
    await adapter.saveBatch([
      [["A", "1"], PAYLOAD_A()],
      [["A", "2"], PAYLOAD_B()],
    ])
    expect(sortByKey(await adapter.loadRange(["A"]))).toStrictEqual(
      sortByKey([
        { key: ["A", "1"], data: PAYLOAD_A() },
        { key: ["A", "2"], data: PAYLOAD_B() },
      ])
    )
  })

  it("lets two adapters share one worker without cross-talk", async () => {
    const shared = new FakeStorageWorker()
    const a = makeAdapter("idb-shared-a", shared).adapter
    const b = makeAdapter("idb-shared-b", shared).adapter
    await a.save(["k"], PAYLOAD_A())
    await b.save(["k"], PAYLOAD_B())
    expect(await a.load(["k"])).toStrictEqual(PAYLOAD_A())
    expect(await b.load(["k"])).toStrictEqual(PAYLOAD_B())
  })

  it("rejects in-flight and subsequent calls when the worker dies", async () => {
    const { adapter, worker } = makeAdapter("idb-crash")
    await adapter.save(["k"], PAYLOAD_A()) // ensure init completed
    worker.dropReplies = true
    const inflight = adapter.load(["k"])
    await tick() // let the call register as pending
    worker.crash("kapow")
    await expect(inflight).rejects.toBeInstanceOf(WorkerStorageError)
    await expect(adapter.load(["k"])).rejects.toBeInstanceOf(WorkerStorageError)
  })

  it("rejects in-flight calls on dispose", async () => {
    const { adapter, worker } = makeAdapter("idb-dispose")
    await adapter.save(["k"], PAYLOAD_A())
    worker.dropReplies = true
    const inflight = adapter.load(["k"])
    await tick()
    adapter.dispose()
    await expect(inflight).rejects.toBeInstanceOf(WorkerStorageError)
  })

  it("falls back to the in-thread adapter when Worker is unavailable", async () => {
    const g = globalThis as { Worker?: unknown }
    const original = g.Worker
    g.Worker = undefined
    try {
      const adapter = track(new IndexedDBWorkerStorageAdapter("idb-fallback"))
      await adapter.save(["k"], new Uint8Array([9]))
      expect(await adapter.load(["k"])).toStrictEqual(new Uint8Array([9]))
    } finally {
      g.Worker = original
    }
  })
})
