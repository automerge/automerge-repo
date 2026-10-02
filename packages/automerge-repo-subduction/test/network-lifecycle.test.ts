import * as A from "@automerge/automerge"
// Fullfat initializes the runtime used by the backend's slim import.
import * as N from "@automerge/subduction"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  recordKey,
  sedimentreeId,
  type SedimentreeEvent,
  type SedimentreeId,
} from "@automerge/automerge-repo/sedimentree"
import { extractRecords } from "@automerge/automerge-repo/sedimentree/automerge"
import { SubductionBackend } from "../src/index.js"
import { DiskStore, deferred } from "./storage.js"
import { PairedTransport } from "./transport.js"

const tree = sedimentreeId("71".repeat(16))
const wait = { timeout: 8000, interval: 10 }
const syncTimeout = 2000
const records = extractRecords(
  A.change(A.init<{ count: number }>({ actor: "aabbcc" }), { time: 0 }, doc => {
    doc.count = 1
  })
)
const baseline = extractRecords(
  A.change(A.init<{ count: number }>({ actor: "ababab" }), { time: 0 }, doc => {
    doc.count = 0
  })
)
const persistedRecords = [...baseline, ...records].sort((a, b) =>
  recordKey(a).localeCompare(recordKey(b))
)
type Peer = {
  storage: DiskStore
  signer: N.MemorySigner
  backend: SubductionBackend
}

function identity(signer: N.MemorySigner) {
  const id = signer.peerId()
  try {
    return { kind: "subduction", id: id.toString(), path: [] }
  } finally {
    id.free()
  }
}

/** Bound assertions without abandoning the underlying promise in cleanup. */
async function bounded<T>(
  work: Promise<T>,
  label: string,
  ms = 8000
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
async function stillPending(work: Promise<unknown>) {
  const state = await Promise.race([
    work.then(
      () => "resolved",
      () => "rejected"
    ),
    new Promise<string>(resolve => setTimeout(() => resolve("pending"), 40)),
  ])
  expect(state).toBe("pending")
}
function errorText(value: unknown): string {
  if (value instanceof Error) {
    return [
      value.message,
      errorText(value.cause),
      ...(value instanceof AggregateError ? value.errors.map(errorText) : []),
    ].join(" ")
  }
  return String(value)
}

describe("authenticated network failure and lifecycle barriers", () => {
  let root: string
  const peers: Peer[] = []
  const transports: PairedTransport[] = []
  const releases: (() => void)[] = []
  const observations: AsyncIterator<unknown>[] = []
  const work: Promise<unknown>[] = []

  // Attach a rejection handler immediately, including to work whose assertion
  // might never be reached. Cleanup releases disk gates BEFORE draining it.
  function track<T>(promise: Promise<T>): Promise<T> {
    work.push(promise)
    void promise.catch(() => {})
    return promise
  }
  function peer(storage?: DiskStore): Peer {
    const signer = N.MemorySigner.fromBytes(
      new Uint8Array(32).fill(peers.length + 21)
    )
    const disk = storage ?? new DiskStore(join(root, `peer-${peers.length}`))
    const result = {
      signer,
      storage: disk,
      backend: new SubductionBackend({
        storage: disk,
        signer,
        syncTimeoutMilliseconds: syncTimeout,
      }),
    }
    peers.push(result)
    return result
  }
  function collect<T>(stream: AsyncIterable<T>) {
    const iterator = stream[Symbol.asyncIterator]()
    observations.push(iterator)
    const events: T[] = []
    const done = track(
      (async () => {
        for (;;) {
          const next = await iterator.next()
          if (next.done) return
          events.push(next.value)
        }
      })()
    )
    return { events, done }
  }
  async function observe(p: Peer, id: SedimentreeId = tree) {
    const session = p.backend.open(id)
    const observed = collect(session.events)
    await vi.waitFor(() => {
      expect(observed.events.some(e => e.type === "local-load-complete")).toBe(
        true
      )
    }, wait)
    return { session, ...observed }
  }
  async function collection(p: Peer) {
    const observed = collect(p.backend.observeCollection())
    await vi.waitFor(() => {
      expect(observed.events.some(e => e.type === "local-load-complete")).toBe(
        true
      )
    }, wait)
    return observed
  }
  function initialRecords(events: SedimentreeEvent[]) {
    return events.flatMap(e =>
      e.type === "records" && e.phase === "initial" ? e.records : []
    )
  }
  function delayIncoming(p: Peer) {
    const entered = deferred(),
      release = deferred()
    releases.push(release.resolve)
    p.storage.beforeSave = async key => {
      if (key.includes("/commits/")) {
        entered.resolve()
        await release.promise
      }
    }
    return { entered: entered.promise, release: release.resolve }
  }
  async function connect(a: Peer, b: Peer) {
    const pair = PairedTransport.pair()
    transports.push(...pair)
    const expected = b.signer.peerId()
    const wrappers: N.AuthenticatedTransport[] = []
    const authenticate = async (promise: Promise<N.AuthenticatedTransport>) => {
      try {
        const wrapper = await promise
        wrappers.push(wrapper)
        return wrapper
      } catch (error) {
        await pair[0].disconnect()
        throw error
      }
    }
    try {
      const results = await Promise.allSettled([
        authenticate(
          N.AuthenticatedTransport.setup(pair[0], a.signer, expected)
        ),
        authenticate(N.AuthenticatedTransport.accept(pair[1], b.signer)),
      ])
      const [left, right] = results.map(result => {
        if (result.status === "rejected") throw result.reason
        return result.value
      })
      const added = await Promise.allSettled([
        a.backend.addConnection(left),
        b.backend.addConnection(right),
      ])
      for (const result of added) {
        if (result.status === "rejected") throw result.reason
        expect(result.value).toBe(true)
      }
      return pair
    } catch (error) {
      await pair[0].disconnect()
      throw error
    } finally {
      wrappers.forEach(wrapper => wrapper.free())
      expected.free()
    }
  }
  async function settledConnection(a: Peer, b: Peer) {
    // Lifecycle tests need supported, nonempty interests, not ambiguous lookups.
    await Promise.all([
      a.backend.store(tree, baseline),
      b.backend.store(tree, baseline),
    ])
    const left = await observe(a),
      right = await observe(b)
    const wire = await connect(a, b)
    // Drain initial interest rounds before deliberately disrupting responses.
    for (const observed of [left, right]) {
      const result = await bounded(
        track(observed.session.synchronize()),
        "initial sync"
      )
      expect(result.outcome).toBe("complete")
    }
    return { left, right, wire }
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "repo-subduction-network-lifecycle-"))
  })
  afterEach(async () => {
    releases.splice(0).forEach(release => release())
    await bounded(
      Promise.allSettled(transports.splice(0).map(t => t.disconnect())),
      "disconnect cleanup"
    )
    await Promise.allSettled(observations.splice(0).map(o => o.return?.()))
    await bounded(
      Promise.allSettled(peers.map(p => p.backend.close())),
      "backend cleanup"
    )
    await bounded(Promise.allSettled(work.splice(0)), "pending work cleanup")
    peers.splice(0).forEach(p => p.signer.free())
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  }, 30000)

  it("keeps observing native successful empty replies, and later pushes still persist", async () => {
    const a = peer(),
      b = peer()
    const nativeSync = N.Subduction.prototype.syncWithPeer
    const replies: { success: boolean; heads: number }[] = []
    vi.spyOn(N.Subduction.prototype, "syncWithPeer").mockImplementation(
      async function (
        this: N.Subduction,
        ...args: Parameters<typeof nativeSync>
      ) {
        const response = await nativeSync.apply(this, args)
        const stats = response.stats
        const heads = stats.remoteHeads
        try {
          replies.push({ success: response.success, heads: heads.length })
        } finally {
          heads.forEach(head => head.free())
          stats.free()
        }
        return response
      }
    )
    const observed = await observe(b)
    await connect(a, b)
    await vi.waitFor(() => {
      expect(observed.events.some(e => e.type === "synchronized")).toBe(true)
    }, wait)
    expect(replies).toContainEqual({ success: true, heads: 0 })
    expect(observed.events.some(e => e.type === "failure")).toBe(false)
    expect(
      observed.events
        .filter(e => e.type === "synchronized")
        .flatMap(e => e.result.peers)
    ).not.toContainEqual(expect.objectContaining({ outcome: "unavailable" }))
    await a.backend.store(tree, records)
    await vi.waitFor(async () => {
      expect(
        (await b.storage.list("subduction-v1/")).some(key =>
          key.includes("/commits/")
        )
      ).toBe(true)
    }, wait)
    expect(initialRecords((await observe(b)).events)).toEqual(records)
  })

  it("does not install a connection when inventory preparation fails, and permits retry", async () => {
    const a = peer(),
      b = peer()
    const pair = PairedTransport.pair()
    transports.push(...pair)
    const expected = b.signer.peerId()
    const wrappers: N.AuthenticatedTransport[] = []
    const authenticate = async (work: Promise<N.AuthenticatedTransport>) => {
      try {
        const wrapper = await work
        wrappers.push(wrapper)
        return wrapper
      } catch (cause) {
        await pair[0].disconnect()
        throw cause
      }
    }
    try {
      const authenticated = await Promise.allSettled([
        authenticate(
          N.AuthenticatedTransport.setup(pair[0], a.signer, expected)
        ),
        authenticate(N.AuthenticatedTransport.accept(pair[1], b.signer)),
      ])
      const [left, right] = authenticated.map(result => {
        if (result.status === "rejected") throw result.reason
        return result.value
      })
      vi.spyOn(b.storage, "list").mockRejectedValueOnce(
        new Error("inventory unavailable")
      )
      await expect(b.backend.addConnection(right)).rejects.toThrow(
        "inventory unavailable"
      )
      // Do NOT disconnect the wire on this failure: doing so would mask a
      // leaked native registration. Authentication wrappers remain borrowed.
      const observed = await observe(b)
      expect((await observed.session.synchronize()).outcome).toBe("no-peers")
      expect(pair[1].disconnected).toBe(false)
      await Promise.all([
        a.backend.store(tree, baseline),
        b.backend.store(tree, baseline),
      ])
      await Promise.all([
        a.backend.addConnection(left),
        b.backend.addConnection(right),
      ])
      expect((await observed.session.synchronize()).outcome).toBe("complete")
    } finally {
      wrappers.forEach(wrapper => wrapper.free())
      expected.free()
    }
  })

  it("automatically syncs unopened documents stored during first onboarding", async () => {
    const a = peer(),
      b = peer()
    const native = (a.backend as unknown as { engine: N.Subduction }).engine
    const entered = deferred(),
      release = deferred()
    releases.push(release.resolve)
    const add = native.addConnection.bind(native)
    vi.spyOn(native, "addConnection").mockImplementation(async transport => {
      entered.resolve()
      await release.promise
      return add(transport)
    })
    const onboarding = track(connect(a, b))
    await bounded(entered.promise, "onboarding after inventory preparation")
    await bounded(
      track(
        (async () => {
          await a.backend.store(tree, records)
          await a.backend.flush()
        })()
      ),
      "store unopened document during paused onboarding",
      800
    )
    expect(await b.storage.list("subduction-v1/")).toEqual([])
    release.resolve()
    await bounded(onboarding, "resume onboarding")
    // No remote session or explicit sync may mask a missed automatic replay.
    await vi.waitFor(
      async () => {
        const stored = await b.storage.list("subduction-v1/")
        expect(stored.filter(key => key.includes("/commits/"))).toHaveLength(
          records.length
        )
      },
      { ...wait, timeout: 2000 }
    )
    expect(initialRecords((await observe(b)).events)).toEqual(records)
  })

  it("reports the authenticated peer and timeout while store/flush stay local despite dropped responses", async () => {
    const a = peer(),
      b = peer()
    const {
      left,
      wire: [wireA, wireB],
    } = await settledConnection(a, b)
    wireB.drop = true
    const sent = vi.spyOn(wireA, "sendBytes")
    const synchronizing = track(left.session.synchronize())
    await vi.waitFor(() => expect(sent).toHaveBeenCalled(), wait)
    await stillPending(synchronizing)

    // This must finish well BEFORE the peer's timeout, not merely eventually.
    await bounded(
      track(
        (async () => {
          await a.backend.store(tree, records)
          await a.backend.flush()
        })()
      ),
      "local store + flush behind a stalled peer",
      800
    )
    expect(initialRecords((await observe(a)).events)).toEqual(persistedRecords)
    await stillPending(synchronizing)

    const result = await bounded(synchronizing, "peer timeout")
    expect(result).toMatchObject({
      outcome: "failed",
      peers: [
        {
          peer: identity(b.signer),
          outcome: "failed",
          error: expect.any(Error),
        },
      ],
    })
    expect(result.peers).toHaveLength(1)
    expect(errorText(result.peers[0].error)).toMatch(/timed?\s*out|timeout/i)
    expect(wireA.disconnected).toBe(false)
  }, 20000)

  it("keeps an unrelated session usable when deletion retires its in-flight connection", async () => {
    const a = peer(),
      b = peer()
    const {
      wire: [wireA, wireB],
    } = await settledConnection(a, b)
    const other = sedimentreeId("73".repeat(16))
    await Promise.all([
      a.backend.store(other, baseline),
      b.backend.store(other, baseline),
    ])
    const observed = await observe(a, other)
    const remote = await observe(b, other)
    await Promise.all([
      observed.session.synchronize(),
      remote.session.synchronize(),
    ])
    wireB.pause()
    const sent = vi.spyOn(wireA, "sendBytes")
    const synchronizing = track(observed.session.synchronize())
    await vi.waitFor(() => expect(sent).toHaveBeenCalled(), wait)
    await stillPending(synchronizing)
    await a.backend.deleteLocal(tree)
    await expect(synchronizing).rejects.toMatchObject({
      code: "io",
      retryable: true,
    })
    await vi.waitFor(() => {
      expect(observed.events).toContainEqual(
        expect.objectContaining({
          type: "failure",
          error: expect.objectContaining({ retryable: true }),
        })
      )
    }, wait)
    await connect(a, b)
    expect((await observed.session.synchronize()).outcome).toBe("complete")
  }, 20000)

  it("AbortSignal cancels only the caller's wait; the same session still receives the completed round", async () => {
    const a = peer(),
      b = peer()
    const {
      left,
      right,
      wire: [wireA, wireB],
    } = await settledConnection(a, b)
    wireB.pause()
    const sent = vi.spyOn(wireA, "sendBytes")
    const abort = new AbortController()
    const synchronizing = track(
      left.session.synchronize({ signal: abort.signal })
    )
    await vi.waitFor(() => expect(sent).toHaveBeenCalled(), wait)
    const priorRounds = left.events.filter(
      e => e.type === "synchronized"
    ).length
    abort.abort()
    await expect(
      bounded(synchronizing, "abort wait", 800)
    ).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(wireA.disconnected).toBe(false)
    wireB.resume()
    await vi.waitFor(() => {
      const rounds = left.events.filter(e => e.type === "synchronized")
      expect(rounds.length).toBeGreaterThan(priorRounds)
      expect(rounds.at(-1)?.result.outcome).toBe("complete")
    }, wait)
    const result = await bounded(
      track(left.session.synchronize()),
      "surviving session sync"
    )
    expect(result).toMatchObject({
      outcome: "complete",
      peers: [{ peer: identity(b.signer), outcome: "complete" }],
    })
    await a.backend.store(tree, records)
    await vi.waitFor(() => {
      const received = right.events.flatMap(e =>
        e.type === "records" ? e.records : []
      )
      expect(received).toEqual(expect.arrayContaining(persistedRecords))
      expect(received).toHaveLength(persistedRecords.length)
    }, wait)
  }, 20000)

  it("flush drains an accepted incoming disk write; close ends watches immediately but waits for that write", async () => {
    const a = peer(),
      b = peer()
    const {
      right,
      wire: [wireA],
    } = await settledConnection(a, b)
    const inventory = await collection(b)
    const gate = delayIncoming(b)
    await a.backend.store(tree, records)
    await bounded(gate.entered, "incoming record save")
    const flushing = track(b.backend.flush())
    await stillPending(flushing)
    const closing = track(b.backend.close())
    expect(b.backend.close()).toBe(closing)
    await bounded(
      Promise.all([right.done, inventory.done]),
      "watches end before disk release",
      800
    )
    await stillPending(closing)
    await vi.waitFor(() => expect(wireA.disconnected).toBe(true), wait)
    gate.release()
    await bounded(
      Promise.all([flushing, closing]),
      "drain incoming save and close"
    )

    // Storage is borrowed: close must neither erase nor render it unusable.
    b.storage.beforeSave = undefined
    await b.storage.save("borrower-marker", new Uint8Array([42]))
    expect(await b.storage.load("borrower-marker")).toEqual(
      new Uint8Array([42])
    )
    const reopened = peer(b.storage)
    expect(initialRecords((await observe(reopened)).events)).toEqual(
      persistedRecords
    )
  }, 20000)

  it("disconnect cancels an in-flight outgoing sync so backend closes do not wait for the timeout", async () => {
    const a = peer(),
      b = peer()
    const {
      left,
      wire: [wireA, wireB],
    } = await settledConnection(a, b)
    wireB.pause()
    const sent = vi.spyOn(wireA, "sendBytes")
    const synchronizing = track(left.session.synchronize())
    await vi.waitFor(() => expect(sent).toHaveBeenCalled(), wait)
    await stillPending(synchronizing)
    const closing = track(a.backend.close())
    await bounded(closing, "close cancels outgoing sync", 800)
    await expect(synchronizing).rejects.toMatchObject({ code: "closed" })
    expect(wireA.disconnected).toBe(true)
    await bounded(
      track(b.backend.close()),
      "remote close after disconnection",
      800
    )
  }, 20000)

  it("deleteLocal drains incoming writes, removes the old generation, and requires an explicit reconnect", async () => {
    const a = peer(),
      b = peer()
    const {
      right,
      wire: [oldA, oldB],
    } = await settledConnection(a, b)
    const gate = delayIncoming(b)
    await a.backend.store(tree, records)
    await bounded(gate.entered, "incoming save before deletion")
    const deleting = track(b.backend.deleteLocal(tree))
    await bounded(right.done, "deleted watch ends", 800)
    expect(right.events.at(-1)).toMatchObject({ type: "deleted" })
    await stillPending(deleting)
    await expect(b.backend.store(tree, records)).rejects.toMatchObject({
      code: "deleted",
    })
    gate.release()
    await bounded(deleting, "delete drains old incoming save")
    expect(await b.storage.list("subduction-v1/")).toEqual([])
    expect(oldA.disconnected).toBe(true)
    expect(oldB.disconnected).toBe(true)
    const fresh = await observe(b)
    expect(initialRecords(fresh.events)).toEqual([])
    expect(await fresh.session.synchronize()).toMatchObject({
      outcome: "no-peers",
      peers: [],
    })

    // More activity on the source and attempts to revive the old wire cannot
    // re-enter the retired generation or silently reconnect the receiver.
    await a.backend.store(tree, records)
    await a.backend.flush()
    oldA.resume()
    oldB.resume()
    await expect(oldA.sendBytes(new Uint8Array([1]))).rejects.toThrow(
      "disconnected"
    )
    expect(await b.storage.list("subduction-v1/")).toEqual([])
    expect(await fresh.session.synchronize()).toMatchObject({
      outcome: "no-peers",
    })
    b.storage.beforeSave = undefined
    await connect(a, b)
    const result = await bounded(
      track(fresh.session.synchronize()),
      "sync after explicit reconnect"
    )
    expect(result.outcome).toBe("complete")
    await b.backend.flush()
    expect(initialRecords((await observe(b)).events)).toEqual(persistedRecords)
  }, 20000)

  it("rescans ambiguous incoming saves, exposes failure to flush, and reconnects without losing or duplicating the record", async () => {
    const a = peer(),
      b = peer()
    const {
      right,
      wire: [oldWire],
    } = await settledConnection(a, b)
    const inventory = await collection(b)
    const save = b.storage.save.bind(b.storage)
    const persisted = deferred()
    let fail = true
    vi.spyOn(b.storage, "save").mockImplementation(async (key, value) => {
      await save(key, value)
      if (key.includes("/commits/") && fail) {
        fail = false
        persisted.resolve()
        throw new Error("ambiguous incoming record save")
      }
    })
    await a.backend.store(tree, records)
    await bounded(persisted.promise, "persist then reject incoming save")
    await bounded(
      Promise.all([right.done, inventory.done]),
      "rescan observations end"
    )
    expect(right.events.at(-1)).toMatchObject({ type: "rescan-required" })
    expect(inventory.events.at(-1)).toMatchObject({ type: "rescan-required" })
    await expect(b.backend.flush()).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AggregateError &&
        errorText(error).includes("ambiguous incoming record save")
    )
    await b.backend.flush()
    await vi.waitFor(() => expect(oldWire.disconnected).toBe(true), wait)

    const fresh = await observe(b)
    expect(initialRecords(fresh.events)).toEqual(persistedRecords)
    expect(await fresh.session.synchronize()).toMatchObject({
      outcome: "no-peers",
      peers: [],
    })
    const freshInventory = await collection(b)
    expect(freshInventory.events.filter(e => e.type === "document")).toEqual([
      expect.objectContaining({ type: "document", id: tree, phase: "initial" }),
    ])
    // A retry can repair the optional inventory marker omitted by the failed
    // transaction. The signed record itself must remain byte-for-byte stable.
    const recordKeys = async () =>
      (await b.storage.list("subduction-v1/")).filter(key =>
        key.includes("/commits/")
      )
    const keys = await recordKeys()
    expect(keys).toHaveLength(persistedRecords.length)
    const bytes = await Promise.all(keys.map(key => b.storage.load(key)))
    await connect(a, b)
    for (let i = 0; i < 2; i++) {
      const result = await bounded(
        track(fresh.session.synchronize()),
        "recovery round"
      )
      expect(result.outcome).toBe("complete")
      await b.backend.store(tree, records)
      await b.backend.flush()
    }
    expect(await recordKeys()).toEqual(keys)
    expect(await Promise.all(keys.map(key => b.storage.load(key)))).toEqual(
      bytes
    )
    await b.backend.close()
    expect(initialRecords((await observe(peer(b.storage))).events)).toEqual(
      persistedRecords
    )
  }, 20000)
})
