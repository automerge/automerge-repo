import * as A from "@automerge/automerge"
// Fullfat initializes the runtime used by the backend's slim import.
import * as N from "@automerge/subduction"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  recordHead,
  sedimentreeId,
  type SedimentreeEvent,
  type SedimentreeId,
} from "@automerge/automerge-repo/sedimentree"
import { extractRecords } from "@automerge/automerge-repo/sedimentree/automerge"
import { SubductionBackend } from "../src/index.js"
import { TestStore, deferred } from "./storage.js"
import {
  PairedTransport,
  connectBackends,
  type TestSigner,
} from "./transport.js"

const tree = sedimentreeId("71".repeat(16) + "00".repeat(16))
const wait = { timeout: 8000, interval: 10 }
const syncTimeout = 2000
const records = extractRecords(
  A.change(A.init<{ count: number }>({ actor: "aabbcc" }), { time: 0 }, doc => {
    doc.count = 1
  })
)
const twoRecords = extractRecords(
  A.change(
    A.change(
      A.init<{ count: number }>({ actor: "acacac" }),
      { time: 0 },
      doc => {
        doc.count = 1
      }
    ),
    { time: 0 },
    doc => {
      doc.count = 2
    }
  )
)
const baseline = extractRecords(
  A.change(A.init<{ count: number }>({ actor: "ababab" }), { time: 0 }, doc => {
    doc.count = 0
  })
)
const persistedRecords = [...baseline, ...records].sort((a, b) =>
  `${a.kind}:${recordHead(a)}`.localeCompare(`${b.kind}:${recordHead(b)}`)
)
type Peer = {
  storage: TestStore
  signer: TestSigner
  backend: SubductionBackend
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
describe("authenticated network failure and lifecycle barriers", () => {
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
  function peer(storage?: TestStore): Peer {
    const signer = N.createMemorySigner(
      new Uint8Array(32).fill(peers.length + 21)
    )
    const disk = storage ?? new TestStore()
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
    await connectBackends(a, b, pair)
    return pair
  }
  async function settledConnection(a: Peer, b: Peer) {
    // Lifecycle tests need supported, nonempty interests, not ambiguous lookups.
    await Promise.all([
      a.backend.store(tree, baseline),
      b.backend.store(tree, baseline),
    ])
    const left = await observe(a),
      right = await observe(b)
    const before = [left.events.length, right.events.length]
    const wire = await connect(a, b)
    // Drain initial interest rounds before deliberately disrupting responses.
    await vi.waitFor(() => {
      for (const [i, observed] of [left, right].entries())
        expect(
          observed.events
            .slice(before[i])
            .some(e => e.type === "history-marker")
        ).toBe(true)
    }, wait)
    return { left, right, wire }
  }

  afterEach(async () => {
    releases.splice(0).forEach(release => release())
    await bounded(
      Promise.allSettled(transports.splice(0).map(t => t.disconnect())),
      "disconnect cleanup"
    )
    await Promise.allSettled(observations.splice(0).map(o => o.return?.()))
    await bounded(
      Promise.allSettled(peers.splice(0).map(p => p.backend.close())),
      "backend cleanup"
    )
    await bounded(Promise.allSettled(work.splice(0)), "pending work cleanup")
    vi.restoreAllMocks()
  }, 30000)

  it("keeps observing an empty peer without a redundant JS sync round, then persists pushes", async () => {
    const a = peer(),
      b = peer()
    const rounds = vi.spyOn(N.Subduction.prototype, "syncWithAllPeers")
    const observed = await observe(b)
    await connect(a, b)
    expect(rounds).not.toHaveBeenCalled()
    expect(observed.events.some(e => e.type === "failure")).toBe(false)
    await a.backend.store(tree, records)
    await vi.waitFor(async () => {
      expect(
        (await b.storage.list("subduction-v2/")).some(key =>
          key.includes("/commits/")
        )
      ).toBe(true)
    }, wait)
    expect(initialRecords((await observe(b)).events)).toEqual(records)
  })

  it("delivers peer data as live records after an empty connected storage scan", async () => {
    const a = peer(),
      b = peer()
    await connect(a, b)
    const observed = await observe(b)
    expect(initialRecords(observed.events)).toEqual([])
    await a.backend.store(tree, records)
    await vi.waitFor(
      () =>
        expect(observed.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "records",
              phase: "live",
              records,
            }),
          ])
        ),
      wait
    )
    expect(initialRecords(observed.events)).toEqual([])
  })

  it("store/flush stay local despite dropped responses", async () => {
    const a = peer(),
      b = peer()
    const {
      wire: [wireA, wireB],
    } = await settledConnection(a, b)
    wireB.drop = true
    // A batch propagates by a round, which stalls on the dropped responses.
    const sent = vi.spyOn(wireA, "sendBytes")
    await a.backend.store(tree, twoRecords)
    await vi.waitFor(() => expect(sent).toHaveBeenCalled(), wait)

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
    expect(initialRecords((await observe(a)).events)).toEqual(
      expect.arrayContaining(persistedRecords)
    )
    expect(wireA.disconnected).toBe(false)
  }, 20000)

  it("deleting another document leaves an in-flight sync and its connection intact", async () => {
    const a = peer(),
      b = peer()
    const {
      wire: [wireA, wireB],
    } = await settledConnection(a, b)
    const other = sedimentreeId("73".repeat(16) + "00".repeat(16))
    await Promise.all([
      a.backend.store(other, baseline),
      b.backend.store(other, baseline),
    ])
    // Keeps A's session on `other` open while its round is in flight.
    await observe(a, other)
    const remote = await observe(b, other)
    wireB.pause()
    // A batch propagates by a round, held in flight by the paused wire.
    const sent = vi.spyOn(wireA, "sendBytes")
    await a.backend.store(other, twoRecords)
    await vi.waitFor(() => expect(sent).toHaveBeenCalled(), wait)
    await a.backend.deleteLocal(tree)
    expect(wireA.disconnected).toBe(false)
    wireB.resume()
    await vi.waitFor(
      () =>
        expect(
          remote.events.flatMap(e => (e.type === "records" ? e.records : []))
        ).toEqual(expect.arrayContaining(twoRecords)),
      wait
    )
  }, 20000)

  it("publishes remote ingested heads to an incomplete session's live marker", async () => {
    const a = peer(),
      b = peer()
    const expectedHeads = [
      recordHead(baseline[0]),
      recordHead(records[0]),
    ].sort()
    const { right } = await settledConnection(a, b)
    const before = right.events.length
    await a.backend.store(tree, records)
    await vi.waitFor(() => {
      const live = right.events.slice(before)
      expect(live.some(e => e.type === "records")).toBe(true)
      const markers = live.filter(e => e.type === "history-marker")
      expect(markers.at(-1)?.marker.heads).toEqual(expectedHeads)
    }, wait)
  }, 20000)

  // Contract: flush covers ingested writes. Native has no barrier yet; see
  // the README's known gaps.
  it.fails("flush drains an accepted incoming disk write", async () => {
    const a = peer(),
      b = peer()
    await settledConnection(a, b)
    const gate = delayIncoming(b)
    await a.backend.store(tree, records)
    await bounded(gate.entered, "incoming record save")
    const flushing = track(b.backend.flush())
    try {
      await stillPending(flushing)
    } finally {
      gate.release()
    }
  }, 20000)

  it("close ends watches immediately but waits for an accepted incoming disk write", async () => {
    const a = peer(),
      b = peer()
    const {
      right,
      wire: [wireA],
    } = await settledConnection(a, b)
    const gate = delayIncoming(b)
    await a.backend.store(tree, records)
    await bounded(gate.entered, "incoming record save")
    const closing = track(b.backend.close())
    expect(b.backend.close()).toBe(closing)
    await bounded(right.done, "watches end before disk release", 800)
    await stillPending(closing)
    await vi.waitFor(() => expect(wireA.disconnected).toBe(true), wait)
    gate.release()
    await bounded(closing, "drain incoming save and close")

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
      wire: [wireA, wireB],
    } = await settledConnection(a, b)
    wireB.pause()
    // A batch propagates by a round, held in flight by the paused wire.
    const sent = vi.spyOn(wireA, "sendBytes")
    await a.backend.store(tree, twoRecords)
    await vi.waitFor(() => expect(sent).toHaveBeenCalled(), wait)
    const closing = track(a.backend.close())
    await bounded(closing, "close cancels outgoing sync", 800)
    expect(wireA.disconnected).toBe(true)
    await bounded(
      track(b.backend.close()),
      "remote close after disconnection",
      800
    )
  }, 20000)

  it("deleteLocal ends the document's watches and removes its history without disconnecting", async () => {
    const a = peer(),
      b = peer()
    const {
      right,
      wire: [wireA, wireB],
    } = await settledConnection(a, b)
    await a.backend.store(tree, records)
    await vi.waitFor(
      async () =>
        expect(
          (await b.storage.list("subduction-v2/")).some(key =>
            key.includes("/commits/")
          )
        ).toBe(true),
      wait
    )
    await bounded(track(b.backend.deleteLocal(tree)), "delete")
    expect(right.events.at(-1)).toMatchObject({ type: "deleted" })
    expect(
      (await b.storage.list("subduction-v2/")).filter(key =>
        key.includes("/commits/")
      )
    ).toEqual([])
    expect(wireA.disconnected).toBe(false)
    expect(wireB.disconnected).toBe(false)
  }, 20000)

  // Contract: deletion orders after earlier writes, including ingested ones,
  // and fences old callbacks. Native does neither yet; see the README's known
  // gaps.
  it.fails("deleteLocal drains an incoming write in flight", async () => {
    const a = peer(),
      b = peer()
    await settledConnection(a, b)
    const gate = delayIncoming(b)
    await a.backend.store(tree, records)
    await bounded(gate.entered, "incoming save before deletion")
    const deleting = track(b.backend.deleteLocal(tree))
    gate.release()
    await bounded(deleting, "delete")
    expect(
      (await b.storage.list("subduction-v2/")).filter(key =>
        key.includes("/commits/")
      )
    ).toEqual([])
  }, 20000)

  it("recovers ambiguous incoming saves and reconnects without losing or duplicating the record", async () => {
    const a = peer(),
      b = peer()
    const {
      right,
      wire: [oldWire],
    } = await settledConnection(a, b)
    const persisted = deferred()
    let fail = true
    b.storage.afterSave = keys => {
      if (keys.some(key => key.includes("/commits/")) && fail) {
        fail = false
        persisted.resolve()
        throw new Error("ambiguous incoming record save")
      }
    }
    await a.backend.store(tree, records)
    await bounded(persisted.promise, "persist then reject incoming save")
    // Native's recovery scan delivers the committed record as live records
    // and the session survives. The scan replays the whole tree, so the
    // baseline repeats.
    await vi.waitFor(
      () =>
        expect(
          right.events.flatMap(e => (e.type === "records" ? e.records : []))
        ).toEqual(expect.arrayContaining(persistedRecords)),
      wait
    )
    // Native may already have dropped the peer whose message failed.
    await oldWire.disconnect()

    const fresh = await observe(b)
    expect(initialRecords(fresh.events)).toEqual(persistedRecords)
    expect(await b.storage.list("subduction-v2/ids/")).toHaveLength(1)
    // A retry can repair the optional inventory marker omitted by the failed
    // transaction. Re-storing held records rewrites them under the same keys
    // (native re-signs them locally); blobs stay identical.
    const recordKeys = async () =>
      (await b.storage.list("subduction-v2/")).filter(key =>
        key.includes("/commits/")
      )
    const keys = await recordKeys()
    expect(keys).toHaveLength(persistedRecords.length * 2)
    const blobKeys = keys.filter(key => key.includes("/blob/"))
    const blobs = await Promise.all(blobKeys.map(key => b.storage.load(key)))
    await connect(a, b)
    for (let i = 0; i < 2; i++) await b.backend.store(tree, records)
    expect(await recordKeys()).toEqual(keys)
    expect(await Promise.all(blobKeys.map(key => b.storage.load(key)))).toEqual(
      blobs
    )
    await b.backend.close()
    expect(initialRecords((await observe(peer(b.storage))).events)).toEqual(
      persistedRecords
    )
  }, 20000)
})
