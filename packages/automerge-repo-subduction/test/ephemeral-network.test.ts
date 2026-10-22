import * as A from "@automerge/automerge"
import * as N from "@automerge/subduction"
import { Repo } from "@automerge/automerge-repo/slim"
import {
  sedimentreeId,
  type EphemeralEnvelope,
  type SedimentreeEvent,
} from "@automerge/automerge-repo/sedimentree"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MemoryByteStore, SubductionBackend } from "../src/index.js"
import { encodeEphemeral } from "../src/ephemeral.js"
import { nativeId } from "../src/storage.js"
import {
  PairedTransport,
  connectBackends,
  type TestSigner,
} from "./transport.js"
import { deferred } from "./storage.js"
import { extractRecords } from "@automerge/automerge-repo/sedimentree/automerge"

const { callbacks } = vi.hoisted(() => ({ callbacks: [] as Function[] }))
vi.mock("@automerge/subduction/slim", async importOriginal => {
  const native = await importOriginal<typeof N>()
  return {
    ...native,
    Subduction: class extends native.Subduction {
      constructor(options: N.SubductionOptions) {
        super(options)
        callbacks.push(options.onEphemeral!)
      }
    },
  }
})

const tree = sedimentreeId("71".repeat(16))
// Same shortened native Topic.toString(), different complete topic.
const other = sedimentreeId("71".repeat(4) + "72".repeat(12))
const wait = { timeout: 8000, interval: 10 }
const message = (
  messageId: string = crypto.randomUUID()
): EphemeralEnvelope => ({
  messageId,
  origin: { kind: "repo", id: "claimed", path: ["child"] },
  payload: new Uint8Array([1, 2, 3]),
})

type Peer = {
  signer: TestSigner
  storage: MemoryByteStore
  backend: SubductionBackend
}

describe("real native ephemerals", () => {
  const peers: ReturnType<typeof peer>[] = []
  const wires: PairedTransport[] = []
  const iterators: AsyncIterator<unknown>[] = []
  const repos: Repo[] = []
  const releases: (() => void)[] = []
  function peer(): Peer {
    const signer = N.createMemorySigner()
    const storage = new MemoryByteStore()
    const backend = new SubductionBackend({ signer, storage })
    const result = { signer, storage, backend }
    peers.push(result)
    return result
  }
  function engine(p: ReturnType<typeof peer>): N.Subduction {
    return (p.backend as unknown as { engine: N.Subduction }).engine
  }
  async function observe(p: ReturnType<typeof peer>, id = tree) {
    const session = p.backend.open(id)
    const events: SedimentreeEvent[] = []
    const iterator = session.events[Symbol.asyncIterator]()
    iterators.push(iterator)
    void (async () => {
      for (;;) {
        const next = await iterator.next()
        if (next.done) return
        events.push(next.value)
      }
    })()
    await vi.waitFor(
      () =>
        expect(events.some(e => e.type === "local-load-complete")).toBe(true),
      wait
    )
    return { session, events }
  }
  /** Give stray duplicates or echoes time to arrive before asserting counts. */
  const settle = () => new Promise(resolve => setTimeout(resolve, 200))
  function ephemerals(events: SedimentreeEvent[]) {
    return events.filter(e => e.type === "ephemeral")
  }
  async function connect(
    a: ReturnType<typeof peer>,
    b: ReturnType<typeof peer>
  ) {
    const pair = PairedTransport.pair()
    wires.push(...pair)
    await connectBackends(a, b, pair)
    // Ordered sends ensure native interest announcements have arrived.
    await Promise.all([
      engine(a).getConnectedPeerIds(),
      engine(b).getConnectedPeerIds(),
    ])
    return pair
  }
  function deliver(
    callback: Function,
    p: ReturnType<typeof peer>,
    envelope: EphemeralEnvelope,
    id = tree,
    bytes = encodeEphemeral(envelope)
  ) {
    callback(nativeId(id), p.signer.peerId(), bytes)
  }
  afterEach(async () => {
    releases.splice(0).forEach(release => release())
    await Promise.allSettled(wires.splice(0).map(w => w.disconnect()))
    await Promise.allSettled(iterators.splice(0).map(i => i.return?.()))
    await Promise.allSettled(repos.splice(0).map(r => r.shutdown()))
    await Promise.allSettled(peers.splice(0).map(p => p.backend.close()))
    callbacks.length = 0
    vi.restoreAllMocks()
  })

  it("delivers once to the peer, never back to the publisher, isolates documents, and never persists", async () => {
    const a = peer(),
      b = peer()
    const left = await observe(a),
      right = await observe(b),
      isolated = await observe(b, other)
    const twin = await observe(b)
    await connect(a, b)
    await Promise.all([left.session.synchronize(), right.session.synchronize()])
    const outgoing = message("same")
    await left.session.publishEphemeral(outgoing)
    await vi.waitFor(
      () => expect(ephemerals(right.events)).toHaveLength(1),
      wait
    )
    expect(ephemerals(right.events)[0]).toMatchObject({
      message: outgoing,
      sender: { kind: "subduction", id: a.signer.peerId(), path: [] },
    })
    await settle()
    expect(ephemerals(right.events)).toHaveLength(1)
    expect(ephemerals(twin.events)).toHaveLength(1)
    expect(ephemerals(left.events)).toHaveLength(0)
    await left.session.publishEphemeral(message("distinct"))
    await vi.waitFor(
      () => expect(ephemerals(right.events)).toHaveLength(2),
      wait
    )
    await settle()
    expect(ephemerals(right.events)).toHaveLength(2)
    expect(ephemerals(left.events)).toHaveLength(0)
    expect(ephemerals(isolated.events)).toHaveLength(0)
    await vi.waitFor(
      () => expect(ephemerals(twin.events)).toHaveLength(2),
      wait
    )
    const first = ephemerals(right.events)[0]
    first.message.payload.fill(9)
    ;(first.message.origin.path as string[]).push("mutated")
    ;(first.sender.path as string[]).push("mutated")
    expect(ephemerals(twin.events)[0].message).toEqual(outgoing)
    expect(ephemerals(twin.events)[0].sender.path).toEqual([])
    await Promise.all([a.backend.flush(), b.backend.flush()])
    expect(await a.storage.list("subduction-v2/")).toEqual([])
    expect(await b.storage.list("subduction-v2/")).toEqual([])
  })

  it("does not replay offline messages; restores interests after reopen and reconnect", async () => {
    const a = peer(),
      b = peer()
    const left = await observe(a),
      right = await observe(b)
    await left.session.publishEphemeral(message("offline"))
    const wire = await connect(a, b)
    await left.session.publishEphemeral(message("online"))
    await vi.waitFor(
      () => expect(ephemerals(right.events)).toHaveLength(1),
      wait
    )
    wire[0].drop = true
    await expect(
      left.session.publishEphemeral(message("dropped"))
    ).resolves.toBeUndefined()
    wire[0].drop = false
    await right.session.close()
    const fresh = await observe(b)
    await wire[0].disconnect()
    await connect(a, b)
    await left.session.publishEphemeral(message("reconnected"))
    await vi.waitFor(
      () => expect(ephemerals(fresh.events)).toHaveLength(1),
      wait
    )
    await left.session.publishEphemeral(message("restored"))
    await vi.waitFor(
      () => expect(ephemerals(fresh.events)).toHaveLength(2),
      wait
    )
    await settle()
    expect(ephemerals(fresh.events)).toHaveLength(2)
    expect(ephemerals(fresh.events).map(e => e.message.messageId)).toEqual([
      "reconnected",
      "restored",
    ])
  })

  it.each([false, true])(
    "preserves the signed originator through relays (cycle: %s)",
    async cycle => {
      const a = peer(),
        relay = peer(),
        b = peer()
      const left = await observe(a),
        middle = await observe(relay),
        right = await observe(b)
      await connect(a, relay)
      await connect(relay, b)
      if (cycle) await connect(b, a)
      await Promise.all([
        left.session.synchronize(),
        middle.session.synchronize(),
        right.session.synchronize(),
      ])
      const outgoing = message()
      await left.session.publishEphemeral(outgoing)
      await vi.waitFor(
        () => expect(ephemerals(right.events)).toHaveLength(1),
        wait
      )
      expect(ephemerals(right.events)[0].sender.id).toBe(a.signer.peerId())
      expect(ephemerals(right.events)[0].sender.id).not.toBe(
        relay.signer.peerId()
      )
      expect(ephemerals(right.events)[0].message).toEqual(outgoing)
      expect(ephemerals(left.events)).toHaveLength(0)
      await vi.waitFor(
        () => expect(ephemerals(middle.events)).toHaveLength(1),
        wait
      )
      // With a cycle, b hears from a directly and via relay; native drops one.
      await settle()
      expect(ephemerals(right.events)).toHaveLength(1)
      expect(ephemerals(middle.events)).toHaveLength(1)
      await left.session.publishEphemeral(message())
      await vi.waitFor(() => {
        expect(ephemerals(right.events)).toHaveLength(2)
        expect(ephemerals(middle.events)).toHaveLength(2)
      }, wait)
      await settle()
      expect(ephemerals(right.events)).toHaveLength(2)
      expect(ephemerals(middle.events)).toHaveLength(2)
      expect(ephemerals(left.events)).toHaveLength(0)
    }
  )

  it("reconciles last-release/reopen and keeps paused control/send/replay outside persistence", async () => {
    const a = peer(),
      b = peer()
    const left = await observe(a),
      right = await observe(b)
    const [wire] = await connect(a, b)
    await Promise.all([left.session.synchronize(), right.session.synchronize()])
    const unsubscribed = deferred(),
      release = deferred()
    releases.push(release.resolve)
    const native = engine(a)
    const unsubscribe = native.unsubscribeEphemeral.bind(native)
    vi.spyOn(native, "unsubscribeEphemeral").mockImplementation(
      async topics => {
        unsubscribed.resolve()
        await release.promise
        return unsubscribe(topics)
      }
    )
    const subscribed = vi.spyOn(native, "subscribeEphemeral")
    await left.session.close()
    await unsubscribed.promise
    const fresh = await observe(a)
    await a.backend.store(tree, [])
    await a.backend.flush()
    release.resolve()
    await vi.waitFor(() => expect(subscribed).toHaveBeenCalledOnce(), wait)
    wire.pause()
    const sent = vi.spyOn(wire, "sendBytes")
    const publishing = fresh.session.publishEphemeral(message())
    await vi.waitFor(() => expect(sent).toHaveBeenCalled(), wait)
    await a.backend.store(tree, [])
    await a.backend.flush()
    wire.resume()
    await publishing
    await wire.disconnect()
    // Native connectTransport replays topics before resolving; gate only that phase.
    const entered = deferred(),
      replayRelease = deferred()
    releases.push(replayRelease.resolve)
    const add = native.connectTransport.bind(native)
    vi.spyOn(native, "connectTransport").mockImplementation(
      async (transport, audience) => {
        entered.resolve()
        await replayRelease.promise
        return add(transport, audience)
      }
    )
    const reconnecting = connect(a, b)
    await entered.promise
    await a.backend.store(tree, [])
    await a.backend.flush()
    replayRelease.resolve()
    await reconnecting
  })

  it("copies before waiting and rejects oversized publications even offline", async () => {
    const a = peer(),
      b = peer()
    const left = await observe(a),
      right = await observe(b)
    await expect(
      left.session.publishEphemeral({
        ...message(),
        payload: new Uint8Array(65536),
      })
    ).rejects.toMatchObject({ operation: "ephemeral", code: "invalid-record" })
    await connect(a, b)
    const input = message()
    const work = left.session.publishEphemeral(input)
    input.payload.fill(8)
    ;(input.origin.path as string[]).push("mutated")
    await work
    await vi.waitFor(
      () => expect(ephemerals(right.events)).toHaveLength(1),
      wait
    )
    expect(ephemerals(right.events)[0].message.payload).toEqual(
      new Uint8Array([1, 2, 3])
    )
    expect(ephemerals(right.events)[0].message.origin.path).toEqual(["child"])
    const large = message()
    const overhead =
      encodeEphemeral({ ...large, payload: new Uint8Array(65000) }).length -
      65000
    const exact = { ...large, payload: new Uint8Array(65536 - overhead) }
    expect(encodeEphemeral(exact)).toHaveLength(65536)
    await left.session.publishEphemeral(exact)
    await vi.waitFor(
      () => expect(ephemerals(right.events)).toHaveLength(2),
      wait
    )
    expect(ephemerals(right.events)[1].message.payload).toHaveLength(
      exact.payload.length
    )
  })

  it("drops malformed, inactive, and post-close callbacks synchronously", async () => {
    const a = peer(),
      b = peer()
    const observed = await observe(b)
    const callback = callbacks[1]
    deliver(callback, a, message(), tree, new Uint8Array([255]))
    deliver(callback, a, message(), tree, new Uint8Array(65537))
    deliver(callback, a, message(), other)
    expect(ephemerals(observed.events)).toHaveLength(0)
    await observed.session.close()
    deliver(callback, a, message())
    await b.backend.close()
    deliver(callback, a, message())
    expect(ephemerals(observed.events)).toHaveLength(0)
  })

  it("releases interests on iterator return without ending durable observation on subscription failure", async () => {
    const a = peer()
    const native = engine(a)
    const subscribe = vi.spyOn(native, "subscribeEphemeral")
    const unsubscribe = vi.spyOn(native, "unsubscribeEphemeral")
    const first = await observe(a)
    await observe(a)
    expect(subscribe).toHaveBeenCalledOnce()
    await first.session.close()
    await a.backend.flush()
    expect(unsubscribe).not.toHaveBeenCalled()
    await iterators[1].return?.()
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce(), wait)
    subscribe.mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
      throw new Error("subscription failed")
    })
    const failed = await observe(a)
    await vi.waitFor(
      () =>
        expect(failed.events.at(-1)).toMatchObject({
          type: "failure",
          error: { operation: "ephemeral", retryable: true },
        }),
      wait
    )
    await expect(
      failed.session.publishEphemeral(message())
    ).resolves.toBeUndefined()
    expect(unsubscribe).toHaveBeenCalledOnce()
    const doc = A.change(
      A.init<{ count: number }>({ actor: "aabbcc" }),
      { time: 0 },
      d => {
        d.count = 1
      }
    )
    const records = extractRecords(doc)
    await a.backend.store(tree, records)
    await vi.waitFor(
      () =>
        expect(
          failed.events.flatMap(e => (e.type === "records" ? e.records : []))
        ).toEqual(records),
      wait
    )
    await expect(failed.session.synchronize()).resolves.toMatchObject({
      outcome: "no-peers",
    })
    await failed.session.close()
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(2), wait)
    const reopened = await observe(a)
    expect(subscribe).toHaveBeenCalledTimes(3)
    await expect(
      reopened.session.publishEphemeral(message())
    ).resolves.toBeUndefined()
  })

  it("deleting another document leaves this session's ephemerals working", async () => {
    const a = peer(),
      b = peer()
    const observed = await observe(a)
    const callback = callbacks[0]
    const deleting = a.backend.deleteLocal(other)
    const publishing = observed.session.publishEphemeral(message())
    deliver(callback, b, message())
    await expect(publishing).resolves.toBeUndefined()
    await deleting
    await vi.waitFor(
      () => expect(ephemerals(observed.events)).toHaveLength(1),
      wait
    )
  })

  it("delivers Repo broadcasts end-to-end without changing document history", async () => {
    const a = peer(),
      b = peer()
    const repoA = new Repo({ backend: a.backend }),
      repoB = new Repo({ backend: b.backend })
    repos.push(repoA, repoB)
    const local = await repoA.create({ count: 1 })
    await connect(a, b)
    const remote = await repoB.find<{ count: number }>(local.documentId)
    const received = vi.fn(),
      echo = vi.fn()
    remote.on("ephemeral-message", received)
    local.on("ephemeral-message", echo)
    local.broadcast({ cursor: [2, 3] })
    await vi.waitFor(() => expect(received).toHaveBeenCalledOnce(), wait)
    expect(received.mock.calls[0][0]).toMatchObject({
      handle: remote,
      senderId: a.signer.peerId(),
      message: { cursor: [2, 3] },
    })
    expect(echo).not.toHaveBeenCalled()
    expect(remote.doc()).toEqual({ count: 1 })
  })
})
