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
import { PairedTransport } from "./transport.js"
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
  signer: N.MemorySigner
  storage: MemoryByteStore
  backend: SubductionBackend
}

describe("real native ephemerals", () => {
  const peers: ReturnType<typeof peer>[] = []
  const wires: PairedTransport[] = []
  const iterators: AsyncIterator<unknown>[] = []
  const repos: Repo[] = []
  const releases: (() => void)[] = []
  function peer(replayEvents = 128, replayBytes = 4 * 1024 * 1024): Peer {
    const signer = N.MemorySigner.generate()
    const storage = new MemoryByteStore()
    const backend = new SubductionBackend({
      signer,
      storage,
      replayEvents,
      replayBytes,
    })
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
  function ephemerals(events: SedimentreeEvent[]) {
    return events.filter(e => e.type === "ephemeral")
  }
  async function connect(
    a: ReturnType<typeof peer>,
    b: ReturnType<typeof peer>
  ) {
    const pair = PairedTransport.pair()
    wires.push(...pair)
    const expected = b.signer.peerId()
    const wrappers: N.AuthenticatedTransport[] = []
    try {
      const results = await Promise.allSettled([
        N.AuthenticatedTransport.setup(pair[0], a.signer, expected),
        N.AuthenticatedTransport.accept(pair[1], b.signer),
      ])
      for (const result of results)
        if (result.status === "fulfilled") wrappers.push(result.value)
      for (const result of results)
        if (result.status === "rejected") throw result.reason
      await Promise.all([
        a.backend.addConnection(wrappers[0]),
        b.backend.addConnection(wrappers[1]),
      ])
      // Ordered sends ensure native interest announcements have arrived.
      await Promise.all([
        engine(a)
          .getConnectedPeerIds()
          .then(ids => ids.forEach(id => id.free())),
        engine(b)
          .getConnectedPeerIds()
          .then(ids => ids.forEach(id => id.free())),
      ])
      return pair
    } finally {
      wrappers.forEach(wrapper => wrapper.free())
      expected.free()
    }
  }
  function deliver(
    callback: Function,
    p: ReturnType<typeof peer>,
    envelope: EphemeralEnvelope,
    id = tree,
    bytes = encodeEphemeral(envelope)
  ) {
    const native = nativeId(id)
    const topic = N.Topic.fromBytes(native.toBytes())
    native.free()
    const sender = p.signer.peerId()
    const topicFree = vi.spyOn(topic, "free")
    const peerFree = vi.spyOn(sender, "free")
    callback(topic, sender, bytes)
    expect(topicFree).toHaveBeenCalledOnce()
    expect(peerFree).toHaveBeenCalledOnce()
  }
  afterEach(async () => {
    releases.splice(0).forEach(release => release())
    await Promise.allSettled(wires.splice(0).map(w => w.disconnect()))
    await Promise.allSettled(iterators.splice(0).map(i => i.return?.()))
    await Promise.allSettled(repos.splice(0).map(r => r.shutdown()))
    await Promise.allSettled(peers.map(p => p.backend.close()))
    peers.splice(0).forEach(p => p.signer.free())
    callbacks.length = 0
    vi.restoreAllMocks()
  })

  it("isolates documents, preserves signed identity, suppresses echo/duplicates, and never persists", async () => {
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
    const sender = a.signer.peerId()
    try {
      expect(ephemerals(right.events)[0]).toMatchObject({
        message: outgoing,
        sender: { kind: "subduction", id: sender.toString(), path: [] },
      })
    } finally {
      sender.free()
    }
    await left.session.publishEphemeral(outgoing)
    await left.session.publishEphemeral(message("distinct"))
    await vi.waitFor(
      () => expect(ephemerals(right.events)).toHaveLength(2),
      wait
    )
    expect(ephemerals(left.events)).toHaveLength(0)
    deliver(callbacks[0], b, outgoing)
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
    expect(await a.storage.list("subduction-v1/")).toEqual([])
    expect(await b.storage.list("subduction-v1/")).toEqual([])
  })

  it("does not replay offline messages; restores interests after reopen, reconnect, and engine retirement", async () => {
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
    const retired = callbacks[1]
    await b.backend.deleteLocal(other)
    deliver(retired, a, message("retired"))
    await connect(a, b)
    await left.session.publishEphemeral(message("restored"))
    await vi.waitFor(
      () => expect(ephemerals(fresh.events)).toHaveLength(2),
      wait
    )
    deliver(callbacks.at(-1)!, a, message("online"))
    deliver(callbacks.at(-1)!, b, message("self"))
    await b.backend.flush()
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
      const signed = a.signer.peerId(),
        forwarded = relay.signer.peerId()
      try {
        expect(ephemerals(right.events)[0].sender.id).toBe(signed.toString())
        expect(ephemerals(right.events)[0].sender.id).not.toBe(
          forwarded.toString()
        )
        expect(ephemerals(right.events)[0].message).toEqual(outgoing)
        expect(ephemerals(left.events)).toHaveLength(0)
        await vi.waitFor(
          () => expect(ephemerals(middle.events)).toHaveLength(1),
          wait
        )
        await left.session.publishEphemeral(outgoing)
        await left.session.publishEphemeral(message())
        await vi.waitFor(() => {
          expect(ephemerals(right.events)).toHaveLength(2)
          expect(ephemerals(middle.events)).toHaveLength(2)
        }, wait)
        expect(ephemerals(left.events)).toHaveLength(0)
      } finally {
        signed.free()
        forwarded.free()
      }
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
    // Native addConnection replays topics before resolving; gate only that phase.
    const entered = deferred(),
      replayRelease = deferred()
    releases.push(replayRelease.resolve)
    const add = native.addConnection.bind(native)
    vi.spyOn(native, "addConnection").mockImplementation(async transport => {
      entered.resolve()
      await replayRelease.promise
      return add(transport)
    })
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

  it("drops malformed, inactive, and retired callbacks synchronously and frees wrappers", async () => {
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

  it("fences stopping callbacks and labels publication failures after a queued reset as ephemeral", async () => {
    const a = peer(),
      b = peer()
    const observed = await observe(a)
    const callback = callbacks[0]
    const deleting = a.backend.deleteLocal(other)
    const publishing = observed.session.publishEphemeral(message())
    deliver(callback, b, message())
    expect(ephemerals(observed.events)).toHaveLength(0)
    await expect(publishing).rejects.toMatchObject({
      operation: "ephemeral",
      code: "io",
    })
    await deleting
    await expect(
      observed.session.publishEphemeral(message())
    ).resolves.toBeUndefined()
  })

  it("retirement waits for started publications before freeing their topic and engine", async () => {
    const a = peer(),
      b = peer()
    const left = await observe(a)
    await observe(b)
    await connect(a, b)
    const native = engine(a)
    const entered = deferred(),
      release = deferred()
    releases.push(release.resolve)
    let freeTopic: ReturnType<typeof vi.spyOn> | undefined
    vi.spyOn(native, "publishEphemeral").mockImplementation(async topic => {
      freeTopic = vi.spyOn(topic, "free")
      entered.resolve()
      await release.promise
    })
    const freeEngine = vi.spyOn(native, "free")
    const publishing = left.session.publishEphemeral(message())
    await entered.promise
    const closing = a.backend.close()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(freeTopic).not.toHaveBeenCalled()
    expect(freeEngine).not.toHaveBeenCalled()
    release.resolve()
    await Promise.all([publishing, closing])
    expect(freeTopic).toHaveBeenCalledOnce()
    expect(freeEngine).toHaveBeenCalledOnce()
  })

  it("retirement waits for started onboarding outside the persistence queue", async () => {
    const a = peer(),
      b = peer()
    await observe(a)
    await observe(b)
    const native = engine(a)
    const entered = deferred(),
      release = deferred()
    releases.push(release.resolve)
    vi.spyOn(native, "addConnection").mockImplementation(async () => {
      entered.resolve()
      await release.promise
      return true
    })
    const freeEngine = vi.spyOn(native, "free")
    const connecting = connect(a, b)
    void connecting.catch(() => {})
    await entered.promise
    const closing = a.backend.close()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(freeEngine).not.toHaveBeenCalled()
    release.resolve()
    await expect(connecting).rejects.toMatchObject({
      operation: "synchronize",
      code: "closed",
    })
    await closing
    expect(freeEngine).toHaveBeenCalledOnce()
  })

  it("drops oversized buffered ephemerals but releases interests on durable overflow", async () => {
    const a = peer(1, 128),
      b = peer()
    const unsubscribe = vi.spyOn(engine(a), "unsubscribeEphemeral")
    const session = a.backend.open(tree)
    const iterator = session.events[Symbol.asyncIterator]()
    iterators.push(iterator)
    expect((await iterator.next()).value).toMatchObject({
      type: "local-load-complete",
    })
    deliver(callbacks[0], b, { ...message(), payload: new Uint8Array(300) })
    await expect(session.publishEphemeral(message())).resolves.toBeUndefined()
    expect(unsubscribe).not.toHaveBeenCalled()
    const doc = A.change(
      A.init<{ count: number }>({ actor: "aabbcc" }),
      { time: 0 },
      d => {
        d.count = 1
      }
    )
    await a.backend.store(tree, extractRecords(doc))
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce(), wait)
    expect((await iterator.next()).value).toMatchObject({
      type: "rescan-required",
    })
    await expect(session.publishEphemeral(message())).rejects.toMatchObject({
      code: "closed",
    })
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
    const signed = a.signer.peerId()
    try {
      expect(received.mock.calls[0][0]).toMatchObject({
        handle: remote,
        senderId: signed.toString(),
        message: { cursor: [2, 3] },
      })
    } finally {
      signed.free()
    }
    expect(echo).not.toHaveBeenCalled()
    expect(remote.doc()).toEqual({ count: 1 })
  })
})
