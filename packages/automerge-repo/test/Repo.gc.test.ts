import { next as A } from "@automerge/automerge"
import { describe, expect, it, vi } from "vitest"
import { DEFAULT_RELEASE_UNOBSERVED_AFTER_MS, Repo } from "../src/Repo.js"
import { DummyNetworkAdapter } from "../src/helpers/DummyNetworkAdapter.js"
import { DummyStorageAdapter } from "../src/helpers/DummyStorageAdapter.js"
import type { DocHandle } from "../src/DocHandle.js"
import { NetworkAdapter } from "../src/index.js"
import type { AutomergeUrl, DocumentId, PeerId } from "../src/index.js"
import { generateAutomergeUrl, parseAutomergeUrl } from "../src/AutomergeUrl.js"
import type { Message } from "../src/network/messages.js"
import connectRepos from "./helpers/connectRepos.js"
import { linkRepos } from "./helpers/linkRepos.js"
import { flushGC, gcAvailable, waitForGC } from "./helpers/flushGC.js"

const describeGC = gcAvailable ? describe : describe.skip

type TestDoc = { foo: string }

/**
 * An always-connected adapter whose remote side the test drives by hand:
 * `arrive` announces a peer, `deliver` injects a message from it, and every
 * message the repo sends goes to `onSend`.
 */
class ScriptedAdapter extends NetworkAdapter {
  onSend: (message: Message) => void = () => {}
  isReady() {
    return true
  }
  whenReady() {
    return Promise.resolve()
  }
  connect(peerId: PeerId) {
    this.peerId = peerId
  }
  disconnect() {}
  send(message: Message) {
    this.onSend(message)
  }
  arrive(peerId: PeerId) {
    this.emit("peer-candidate", { peerId, peerMetadata: {} })
  }
  leave(peerId: PeerId) {
    this.emit("peer-disconnected", { peerId })
  }
  deliver(message: Message) {
    this.emit("message", message)
  }
}

/**
 * End-to-end tests for the consumer-driven memory model: holding a handle
 * (or keeping a listener attached) keeps a document loaded; dropping every
 * reference lets the Repo release all of its per-document coordination
 * state (query, synchronizer, handles, registry) automatically.
 */
describeGC("Repo GC of dropped documents", () => {
  it("collects a document once the consumer drops its handle", async () => {
    const repo = new Repo({ releaseUnobservedAfterMs: 0 })
    let documentId!: DocumentId
    let probe!: WeakRef<DocHandle<TestDoc>>

      // Scope the handle so the test frame doesn't pin it.
    ;(() => {
      const handle = repo.create<TestDoc>({ foo: "dropped" })
      documentId = handle.documentId
      probe = new WeakRef(handle)
    })()

    expect(await waitForGC(probe, 2000)).toBe(true)
    expect(repo.handles[documentId]).toBeUndefined()
    expect(repo.synchronizer.docSynchronizers[documentId]).toBeUndefined()
  })

  it("collects a document once root and sub-handles are all dropped", async () => {
    const repo = new Repo({ releaseUnobservedAfterMs: 0 })
    let documentId!: DocumentId
    let rootProbe!: WeakRef<DocHandle<any>>
    let subProbe!: WeakRef<DocHandle<string>>

      // Scope root and sub together, with listener churn on the sub, so the
      // whole cluster (root, subs, registry wiring) must collapse as a unit.
    ;(() => {
      const root = repo.create<any>({ nested: { value: "dropped" } })
      documentId = root.documentId
      const sub = root.sub("nested", "value")
      const listener = () => {}
      sub.on("change", listener)
      sub.off("change", listener)
      rootProbe = new WeakRef(root)
      subProbe = new WeakRef(sub)
    })()

    expect(await waitForGC(rootProbe, 2000)).toBe(true)
    expect(await waitForGC(subProbe, 2000)).toBe(true)
    expect(repo.handles[documentId]).toBeUndefined()
    expect(repo.synchronizer.docSynchronizers[documentId]).toBeUndefined()
  })

  it("keeps a document alive while the consumer holds a handle", async () => {
    const repo = new Repo({ releaseUnobservedAfterMs: 0 })
    const handle = repo.create<TestDoc>({ foo: "held" })

    // Negative assertion: a best-effort GC must not evict a held document.
    await flushGC()

    expect(repo.handles[handle.documentId]).toBe(handle)
    expect(repo.synchronizer.docSynchronizers[handle.documentId]).toBeDefined()
  })

  it("keeps a held document loaded after the consumer's removeAllListeners", async () => {
    const repo = new Repo({ releaseUnobservedAfterMs: 0 })
    const handle = repo.create<TestDoc>({ foo: "held" })
    handle.on("change", () => {})
    handle.removeAllListeners()

    await flushGC()

    expect(await repo.find<TestDoc>(handle.url)).toBe(handle)
    expect(repo.synchronizer.docSynchronizers[handle.documentId]).toBeDefined()
  })

  it("keeps the whole document alive while only a sub-handle is held", async () => {
    const repo = new Repo({ releaseUnobservedAfterMs: 0 })
    let sub!: DocHandle<string>
    let rootProbe!: WeakRef<DocHandle<any>>

    ;(() => {
      const root = repo.create<any>({ nested: { value: "kept" } })
      rootProbe = new WeakRef(root)
      sub = root.sub("nested", "value")
    })()

    await flushGC()

    // The sub-handle reaches the shared document, whose registry retains
    // the root handle (it carries the repo's internal listeners).
    expect(rootProbe.deref()).toBeDefined()
    expect(repo.handles[sub.documentId]).toBeDefined()
    expect(sub.doc()).toBe("kept")
  })

  it("re-loads a collected document from storage on the next find()", async () => {
    const storage = new DummyStorageAdapter()
    const repo = new Repo({ storage, releaseUnobservedAfterMs: 0 })
    let url!: AutomergeUrl
    let probe!: WeakRef<DocHandle<TestDoc>>

    ;(() => {
      const handle = repo.create<TestDoc>({ foo: "persisted" })
      url = handle.url
      probe = new WeakRef(handle)
    })()
    await repo.flush()

    expect(await waitForGC(probe, 2000)).toBe(true)

    // The cache miss re-loads through the ordinary ensureQuery path.
    const fresh = await repo.find<TestDoc>(url)
    expect(fresh.doc()).toEqual({ foo: "persisted" })

    // The re-created document gets fresh storage wiring: a new change
    // persists and survives a reload from the same storage in another repo.
    fresh.change(d => {
      d.foo = "persisted-again"
    })
    await repo.flush()
    const other = new Repo({ storage })
    const reloaded = await other.find<TestDoc>(url)
    expect(reloaded.doc()).toEqual({ foo: "persisted-again" })
  })

  it("a listener keeps the document rooted after the handle is dropped", async () => {
    const repo = new Repo({ releaseUnobservedAfterMs: 0 })
    let url!: AutomergeUrl
    let documentId!: DocumentId
    const events: string[] = []

    ;(() => {
      const handle = repo.create<TestDoc>({ foo: "start" })
      url = handle.url
      documentId = handle.documentId
      handle.on("change", ({ doc }) => {
        if (doc) events.push(doc.foo)
      })
    })()

    // Negative assertion: the external listener roots the document even
    // though no handle is held anywhere.
    await flushGC()
    expect(repo.handles[documentId]).toBeDefined()

    // The registry canonicalizes handles, so a re-find returns the same
    // instance the listener was attached to, and changes still reach it.
    let probe!: WeakRef<DocHandle<TestDoc>>
    await (async () => {
      const again = await repo.find<TestDoc>(url)
      probe = new WeakRef(again)
      again.change(d => {
        d.foo = "updated"
      })
      expect(events).toEqual(["updated"])

      // Removing the listener releases the root; dropping the handle then
      // lets the whole document go.
      again.removeAllListeners()
    })()

    expect(await waitForGC(probe, 2000)).toBe(true)
    expect(repo.handles[documentId]).toBeUndefined()
  })

  it("removeFromCache severs listener rooting", async () => {
    const repo = new Repo({ releaseUnobservedAfterMs: 0 })
    let documentId!: DocumentId
    let probe!: WeakRef<DocHandle<TestDoc>>

    ;(() => {
      const handle = repo.create<TestDoc>({ foo: "torn-down" })
      documentId = handle.documentId
      probe = new WeakRef(handle)
      handle.on("change", () => {})
    })()

    await repo.removeFromCache(documentId)

    // Explicit teardown wins over the lingering listener.
    expect(await waitForGC(probe, 2000)).toBe(true)
    expect(repo.handles[documentId]).toBeUndefined()
  })

  it("collects a document created only by inbound sync once sync settles", async () => {
    // Sync-server shape: bob receives and serves a document without any
    // local consumer ever holding a handle to it.
    const alice = new Repo({ peerId: "alice" as PeerId })
    const bob = new Repo({
      peerId: "bob" as PeerId,
      releaseUnobservedAfterMs: 0,
    })
    await connectRepos(alice, bob)

    const aliceHandle = alice.create<TestDoc>({ foo: "shared" })
    const documentId = aliceHandle.documentId

    let probe!: WeakRef<DocHandle<TestDoc>>
    await (async () => {
      const bobHandle = await bob.find<TestDoc>(aliceHandle.url)
      probe = new WeakRef(bobHandle)
      expect(bobHandle.doc()).toEqual({ foo: "shared" })
    })()

    // With no consumer references on bob's side, bob's copy is collectable.
    // (The sync-throttle timer pins it briefly; the budget outlasts it.)
    expect(await waitForGC(probe, 3000)).toBe(true)
    expect(bob.handles[documentId]).toBeUndefined()
    expect(bob.synchronizer.docSynchronizers[documentId]).toBeUndefined()

    // A fresh find re-requests the document from alice.
    const again = await bob.find<TestDoc>(aliceHandle.url)
    expect(again.doc()).toEqual({ foo: "shared" })
  })
})

describeGC("Repo GC cross-cutting pins", () => {
  const SAVE_DEBOUNCE_MS = 100

  it("a pending save throttle pins the handle until it fires", async () => {
    // The heads-changed save listener retains {handle, doc} through the
    // throttle's pending setTimeout, so a change always reaches storage
    // even if the consumer drops the handle immediately afterwards.
    // Partial fake timers capture the throttle while setImmediate stays
    // real for the GC helpers' macrotask yields.
    let probe!: WeakRef<DocHandle<TestDoc>>
    const repo = new Repo({
      storage: new DummyStorageAdapter(),
      saveDebounceRate: SAVE_DEBOUNCE_MS,
      releaseUnobservedAfterMs: 0,
    })

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      ;(() => {
        const handle = repo.create<TestDoc>({ foo: "bar" })
        handle.change(d => {
          d.foo = "baz"
        })
        probe = new WeakRef(handle)
      })()

      // The throttle timer has not fired: its closure pins the handle.
      await flushGC()
      expect(probe.deref()).toBeDefined()

      // Fire the pending save (and sync) throttles, releasing the closures.
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 2 + 50)
    } finally {
      vi.useRealTimers()
    }

    expect(await waitForGC(probe, 2000)).toBe(true)
  })

  it("a repo.handles snapshot pins; a later snapshot reflects the drop", async () => {
    let probe!: WeakRef<DocHandle<TestDoc>>
    let documentId!: DocumentId
    let snapshot: Record<DocumentId, DocHandle<any>> | undefined
    const repo = new Repo({
      storage: new DummyStorageAdapter(),
      saveDebounceRate: SAVE_DEBOUNCE_MS,
      releaseUnobservedAfterMs: 0,
    })

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      ;(() => {
        const handle = repo.create<TestDoc>({ foo: "bar" })
        documentId = handle.documentId
        probe = new WeakRef(handle)
      })()
      await repo.flush()
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 2 + 50)
      // The snapshot Record strongly references the handle.
      snapshot = repo.handles
    } finally {
      vi.useRealTimers()
    }

    await flushGC()
    expect(probe.deref()).toBeDefined()
    expect(snapshot![documentId]).toBeDefined()

    snapshot = undefined
    // Handle collected AND a fresh snapshot no longer lists it (the weak
    // map's iterator skips dead entries).
    expect(
      await waitForGC(
        () =>
          probe.deref() === undefined && repo.handles[documentId] === undefined,
        2000
      )
    ).toBe(true)
  })

  it("a peer's unanswered request pins the document until it is answered", async () => {
    // Relay shape: the relay has no copy, so it asks upstream on the
    // requester's behalf. Nothing local references the document meanwhile.
    const toRequester = new ScriptedAdapter()
    const toUpstream = new ScriptedAdapter()
    const fromRelay = new ScriptedAdapter()
    const relay = new Repo({
      peerId: "relay" as PeerId,
      releaseUnobservedAfterMs: 0,
      network: [toRequester, toUpstream],
    })
    const upstream = new Repo({
      peerId: "upstream" as PeerId,
      network: [fromRelay],
      shareConfig: { announce: async () => false, access: async () => true },
    })
    const upstreamHandle = upstream.create<TestDoc>({ foo: "found" })
    const { documentId } = upstreamHandle

    // Hold the relay's messages to upstream until released.
    let release!: () => void
    const released = new Promise<void>(resolve => (release = resolve))
    let asked!: () => void
    const askedUpstream = new Promise<void>(resolve => (asked = resolve))
    toUpstream.onSend = message => {
      asked()
      void released.then(() => fromRelay.deliver(message))
    }
    fromRelay.onSend = message =>
      queueMicrotask(() => toUpstream.deliver(message))

    let answered!: () => void
    const answeredRequester = new Promise<void>(resolve => (answered = resolve))
    toRequester.onSend = message => {
      if (message.type !== "sync") return
      if (A.decodeSyncMessage(message.data).heads.length > 0) answered()
    }

    toRequester.arrive("requester" as PeerId)
    toUpstream.arrive("upstream" as PeerId)
    fromRelay.arrive("relay" as PeerId)

    const [, request] = A.generateSyncMessage(A.init(), A.initSyncState())
    toRequester.deliver({
      type: "request",
      senderId: "requester" as PeerId,
      targetId: "relay" as PeerId,
      documentId,
      data: request!,
    })
    await askedUpstream

    let probe!: WeakRef<DocHandle<unknown>>
    ;(() => {
      probe = new WeakRef(relay.handles[documentId])
    })()

    await flushGC()
    expect(probe.deref()).toBeDefined()

    release()
    await answeredRequester
    expect(upstreamHandle.doc()).toEqual({ foo: "found" })

    // (The sync-throttle timer pins it briefly; the budget outlasts it.)
    expect(await waitForGC(probe, 3000)).toBe(true)
  })

  /**
   * A relay without the document between a scripted requester and a
   * connected upstream that never answers, so every request stays unanswered.
   */
  const setupSilentRelay = (options: { maxPinnedRequestsPerPeer?: number }) => {
    const toRequester = new ScriptedAdapter()
    const toUpstream = new ScriptedAdapter()
    const relay = new Repo({
      peerId: "relay" as PeerId,
      releaseUnobservedAfterMs: 0,
      network: [toRequester, toUpstream],
      ...options,
    })
    const asked = new Map<DocumentId, () => void>()
    toUpstream.onSend = message => {
      if ("documentId" in message && message.documentId) {
        asked.get(message.documentId)?.()
      }
    }
    toRequester.arrive("requester" as PeerId)
    toUpstream.arrive("upstream" as PeerId)

    /** Deliver the requester's request; resolve once the relay asks upstream. */
    const request = async (): Promise<{
      documentId: DocumentId
      probe: WeakRef<DocHandle<unknown>>
    }> => {
      const { documentId } = parseAutomergeUrl(generateAutomergeUrl())
      const askedUpstream = new Promise<void>(resolve =>
        asked.set(documentId, resolve)
      )
      const [, data] = A.generateSyncMessage(A.init(), A.initSyncState())
      toRequester.deliver({
        type: "request",
        senderId: "requester" as PeerId,
        targetId: "relay" as PeerId,
        documentId,
        data: data!,
      })
      await askedUpstream
      let probe!: WeakRef<DocHandle<unknown>>
      ;(() => {
        probe = new WeakRef(relay.handles[documentId])
      })()
      return { documentId, probe }
    }

    return { relay, toRequester, request }
  }

  it("removeFromCache releases a document pinned by an unanswered request", async () => {
    const { relay, request } = setupSilentRelay({})
    const { documentId, probe } = await request()

    await flushGC()
    expect(probe.deref()).toBeDefined()

    await relay.removeFromCache(documentId)
    expect(await waitForGC(probe, 2000)).toBe(true)
  })

  it("delete releases a document pinned by an unanswered request", async () => {
    const { relay, request } = setupSilentRelay({})
    const { documentId, probe } = await request()

    await flushGC()
    expect(probe.deref()).toBeDefined()

    relay.delete(documentId)
    expect(await waitForGC(probe, 2000)).toBe(true)
  })

  it("the requester disconnecting releases the pin", async () => {
    const { toRequester, request } = setupSilentRelay({})
    const { probe } = await request()

    await flushGC()
    expect(probe.deref()).toBeDefined()

    toRequester.leave("requester" as PeerId)
    expect(await waitForGC(probe, 2000)).toBe(true)
  })

  it("pins at most maxPinnedRequestsPerPeer documents per peer", async () => {
    const { request } = setupSilentRelay({ maxPinnedRequestsPerPeer: 1 })
    const first = await request()
    const second = await request()

    // The request over the cap was still forwarded upstream (request()
    // resolved), but only the first document is pinned.
    expect(await waitForGC(second.probe, 2000)).toBe(true)
    await flushGC()
    expect(first.probe.deref()).toBeDefined()
  })

  it("maxPinnedRequestsPerPeer: Infinity is accepted and pins unanswered requests", async () => {
    const { request } = setupSilentRelay({ maxPinnedRequestsPerPeer: Infinity })
    const probes = []
    for (let i = 0; i < 5; i++) probes.push((await request()).probe)

    await flushGC()
    expect(probes.every(probe => probe.deref() !== undefined)).toBe(true)
  })

  it("a storage-less viewer keeps receiving changes after the server releases the document", async () => {
    // The server announces nothing, so it sends a document only to peers
    // that asked for it. The viewer has no storage, so the server keeps no
    // sync state for it.
    const server = new Repo({
      peerId: "server" as PeerId,
      storage: new DummyStorageAdapter(),
      releaseUnobservedAfterMs: 0,
      shareConfig: { announce: async () => false, access: async () => true },
    })
    const editor = new Repo({
      peerId: "editor" as PeerId,
      storage: new DummyStorageAdapter(),
    })
    const viewer = new Repo({ peerId: "viewer" as PeerId })
    await linkRepos(editor, server)
    await linkRepos(viewer, server)

    const editorHandle = editor.create<{ n: number }>({ n: 0 })
    const { documentId } = editorHandle
    const viewerHandle = await viewer.find<{ n: number }>(editorHandle.url)

    let probe!: WeakRef<DocHandle<unknown>>
    ;(() => {
      probe = new WeakRef(server.handles[documentId])
    })()
    expect(await waitForGC(probe, 3000)).toBe(true)

    const received = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("viewer never received the change")),
        2000
      )
      viewerHandle.on("change", ({ doc }) => {
        if (doc?.n !== 1) return
        clearTimeout(timer)
        resolve()
      })
    })
    editorHandle.change(d => {
      d.n = 1
    })
    await received
    expect(viewerHandle.doc()).toEqual({ n: 1 })
  })
})

describeGC("Repo release of unobserved documents", () => {
  const PERIOD = 1000
  /** Longer than DocSynchronizer's change throttle. */
  const SYNC_THROTTLE_MS = 150

  /** Let messages in flight between linked repos be delivered. */
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise(setImmediate)
  }

  /** Resolves once `handle` has `heads`. */
  const untilHeads = (handle: DocHandle<unknown>, heads: A.Heads) =>
    new Promise<void>(resolve => {
      if (A.equals(handle.heads(), heads)) return resolve()
      const onHeads = () => {
        if (!A.equals(handle.heads(), heads)) return
        handle.off("heads-changed", onHeads)
        resolve()
      }
      handle.on("heads-changed", onHeads)
    })

  it("without storage, keeps a dropped document by default", async () => {
    const repo = new Repo()
    let url!: AutomergeUrl
    let probe!: WeakRef<DocHandle<TestDoc>>
    fakeRepoTimers()
    try {
      ;(() => {
        const handle = repo.create<TestDoc>({ foo: "only copy" })
        url = handle.url
        probe = new WeakRef(handle)
      })()

      vi.advanceTimersByTime(3 * DEFAULT_RELEASE_UNOBSERVED_AFTER_MS)
      await flushGC()
      expect(probe.deref()).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
    const found = await repo.find<TestDoc>(url)
    expect(found).toBe(probe.deref())
    expect(found.doc()).toEqual({ foo: "only copy" })
  })

  it("without storage, a dropped repo is collectable once its connection closes", async () => {
    const server = new Repo({ storage: new DummyStorageAdapter() })
    const probe = await (async () => {
      const client = new Repo()
      const [toServer, toClient] = DummyNetworkAdapter.createConnectedPair()
      client.networkSubsystem.addNetworkAdapter(toServer)
      server.networkSubsystem.addNetworkAdapter(toClient)
      toServer.peerCandidate(server.peerId)
      toClient.peerCandidate(client.peerId)
      const handle = client.create<TestDoc>({ foo: "client copy" })
      await server.find<TestDoc>(handle.url)
      toServer.disconnect()
      toClient.disconnect()
      return new WeakRef(client)
    })()

    expect(await waitForGC(probe, 2000)).toBe(true)
  })

  it("Infinity keeps the handle, synchronizer and sync info of a dropped document", async () => {
    const a = new Repo({
      peerId: "a" as PeerId,
      storage: new DummyStorageAdapter(),
      releaseUnobservedAfterMs: Infinity,
    })
    const b = new Repo({
      peerId: "b" as PeerId,
      storage: new DummyStorageAdapter(),
    })
    await linkRepos(a, b)
    const storageIdOfB = a.getStorageIdOfPeer(b.peerId)!
    expect(storageIdOfB).toBeDefined()

    let url!: AutomergeUrl
    let documentId!: DocumentId
    let handleProbe!: WeakRef<DocHandle<TestDoc>>
    let docSyncProbe!: WeakRef<object>
    await (async () => {
      const handle = a.create<TestDoc>({ foo: "synced" })
      url = handle.url
      documentId = handle.documentId
      const synced = new Promise<void>(resolve =>
        handle.on("remote-heads", function onRemoteHeads({ storageId }) {
          if (storageId !== storageIdOfB) return
          if (
            !A.equals(
              handle.getSyncInfo(storageIdOfB)!.lastHeads,
              handle.heads()
            )
          )
            return
          handle.off("remote-heads", onRemoteHeads)
          resolve()
        })
      )
      await b.find(url)
      await synced
      handleProbe = new WeakRef(handle)
      docSyncProbe = new WeakRef(a.synchronizer.docSynchronizers[documentId])
    })()

    await flushGC()
    const found = await a.find<TestDoc>(url)
    expect(found).toBe(handleProbe.deref())
    expect(a.synchronizer.docSynchronizers[documentId]).toBe(
      docSyncProbe.deref()
    )
    expect(found.getSyncInfo(storageIdOfB)?.lastHeads).toEqual(found.heads())
  })

  /** Fake every timer the repo uses; setImmediate stays real for GC and delivery. */
  const fakeRepoTimers = () =>
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    })

  it("with storage, releases a dropped document after the default period", async () => {
    fakeRepoTimers()
    try {
      const repo = new Repo({ storage: new DummyStorageAdapter() })
      let documentId!: DocumentId
      let probe!: WeakRef<DocHandle<TestDoc>>
      ;(() => {
        const handle = repo.create<TestDoc>({ foo: "stored" })
        documentId = handle.documentId
        probe = new WeakRef(handle)
      })()
      await repo.flush([documentId])
      // Fire the save throttle, which pins the document until it runs.
      const throttle = 1000
      await vi.advanceTimersByTimeAsync(throttle)

      vi.advanceTimersByTime(DEFAULT_RELEASE_UNOBSERVED_AFTER_MS - throttle)
      await flushGC()
      expect(probe.deref()).toBeDefined()

      vi.advanceTimersByTime(DEFAULT_RELEASE_UNOBSERVED_AFTER_MS)
      expect(await waitForGC(probe, 2000)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("rejects a negative or NaN period", () => {
    for (const releaseUnobservedAfterMs of [-1, NaN]) {
      expect(() => new Repo({ releaseUnobservedAfterMs })).toThrow(RangeError)
    }
  })

  it("a finite period does not keep a document this repo does not have", async () => {
    const network = new ScriptedAdapter()
    const repo = new Repo({
      peerId: "server" as PeerId,
      storage: new DummyStorageAdapter(),
      network: [network],
      releaseUnobservedAfterMs: 60_000,
    })
    network.arrive("requester" as PeerId)
    const { documentId } = parseAutomergeUrl(generateAutomergeUrl())
    const unavailable = new Promise<void>(resolve => {
      network.onSend = message => {
        if (message.type === "doc-unavailable") resolve()
      }
    })
    const [, data] = A.generateSyncMessage(A.init(), A.initSyncState())
    network.deliver({
      type: "request",
      senderId: "requester" as PeerId,
      targetId: "server" as PeerId,
      documentId,
      data: data!,
    })
    await unavailable

    let probe!: WeakRef<DocHandle<unknown>>
    ;(() => {
      probe = new WeakRef(repo.handles[documentId])
    })()
    expect(await waitForGC(probe, 2000)).toBe(true)
  })

  it("a change to a removed document does not keep it again", async () => {
    const repo = new Repo({ releaseUnobservedAfterMs: Infinity })
    let probe!: WeakRef<DocHandle<TestDoc>>
    await (async () => {
      const handle = repo.create<TestDoc>({ foo: "kept" })
      probe = new WeakRef(handle)
      await repo.removeFromCache(handle.documentId)
      handle.change(d => {
        d.foo = "after removal"
      })
    })()
    expect(await waitForGC(probe, 2000)).toBe(true)
  })

  it("shutdown stops the release timer", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    try {
      const repo = new Repo({ releaseUnobservedAfterMs: PERIOD })
      repo.create<TestDoc>({ foo: "x" })
      expect(vi.getTimerCount()).toBe(1)
      await repo.shutdown()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("a finite period releases a document one to two periods after its last activity", async () => {
    fakeRepoTimers()
    try {
      const repo = new Repo({ releaseUnobservedAfterMs: PERIOD })
      let probe!: WeakRef<DocHandle<TestDoc>>
      ;(() => {
        probe = new WeakRef(repo.create<TestDoc>({ foo: "kept a while" }))
      })()

      vi.advanceTimersByTime(PERIOD)
      await flushGC()
      expect(probe.deref()).toBeDefined()

      vi.advanceTimersByTime(PERIOD)
      expect(await waitForGC(probe, 2000)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("a local change restarts the period", async () => {
    fakeRepoTimers()
    try {
      const repo = new Repo({ releaseUnobservedAfterMs: PERIOD })
      let probe!: WeakRef<DocHandle<TestDoc>>
      let handle: DocHandle<TestDoc> | undefined = repo.create<TestDoc>({
        foo: "first",
      })
      ;(() => {
        probe = new WeakRef(handle!)
      })()

      vi.advanceTimersByTime(PERIOD)
      handle.change(d => {
        d.foo = "second"
      })
      handle = undefined

      // Two periods after creation, one after the change.
      vi.advanceTimersByTime(PERIOD)
      await flushGC()
      expect(probe.deref()).toBeDefined()

      vi.advanceTimersByTime(PERIOD)
      expect(await waitForGC(probe, 2000)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("a peer's change restarts the period", async () => {
    fakeRepoTimers()
    try {
      const server = new Repo({
        peerId: "server" as PeerId,
        releaseUnobservedAfterMs: PERIOD,
      })
      const editor = new Repo({ peerId: "editor" as PeerId })
      await linkRepos(editor, server)
      const handle = editor.create<TestDoc>({ foo: "first" })
      const { documentId } = handle

      let probe!: WeakRef<DocHandle<unknown>>
      await (async () => {
        const serverHandle = await server.find(handle.url)
        await untilHeads(serverHandle, handle.heads())
        probe = new WeakRef(serverHandle)
      })()

      vi.advanceTimersByTime(PERIOD)
      handle.change(d => {
        d.foo = "second"
      })
      // Fire the editor's sync throttle so the change is sent, then the
      // throttles it triggers, and let the replies settle.
      vi.advanceTimersByTime(SYNC_THROTTLE_MS)
      await untilHeads(server.handles[documentId], handle.heads())
      vi.advanceTimersByTime(SYNC_THROTTLE_MS)
      await settle()

      // Two periods after the first activity, one after the second.
      vi.advanceTimersByTime(PERIOD - 2 * SYNC_THROTTLE_MS)
      await flushGC()
      expect(probe.deref()).toBeDefined()

      vi.advanceTimersByTime(PERIOD)
      expect(await waitForGC(probe, 2000)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("a peer's request restarts the period", async () => {
    fakeRepoTimers()
    try {
      const network = new ScriptedAdapter()
      const repo = new Repo({
        peerId: "server" as PeerId,
        network: [network],
        releaseUnobservedAfterMs: PERIOD,
      })
      network.arrive("requester" as PeerId)
      let documentId!: DocumentId
      let probe!: WeakRef<DocHandle<TestDoc>>
      ;(() => {
        const handle = repo.create<TestDoc>({ foo: "requested" })
        documentId = handle.documentId
        probe = new WeakRef(handle)
      })()
      await settle()

      vi.advanceTimersByTime(PERIOD)
      const answered = new Promise<void>(resolve => {
        network.onSend = message => {
          if (message.type === "sync") resolve()
        }
      })
      const [, request] = A.generateSyncMessage(A.init(), A.initSyncState())
      network.deliver({
        type: "request",
        senderId: "requester" as PeerId,
        targetId: "server" as PeerId,
        documentId,
        data: request!,
      })
      await answered

      // Two periods after creation, one after the request.
      vi.advanceTimersByTime(PERIOD)
      await flushGC()
      expect(probe.deref()).toBeDefined()

      vi.advanceTimersByTime(PERIOD)
      expect(await waitForGC(probe, 2000)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("removeFromCache releases a kept document at once", async () => {
    const repo = new Repo({ releaseUnobservedAfterMs: Infinity })
    let documentId!: DocumentId
    let probe!: WeakRef<DocHandle<TestDoc>>
    ;(() => {
      const handle = repo.create<TestDoc>({ foo: "kept" })
      documentId = handle.documentId
      probe = new WeakRef(handle)
    })()

    await flushGC()
    expect(probe.deref()).toBeDefined()
    await repo.removeFromCache(documentId)
    expect(await waitForGC(probe, 2000)).toBe(true)
  })

  it("delete releases a kept document at once", async () => {
    const repo = new Repo({ releaseUnobservedAfterMs: Infinity })
    let documentId!: DocumentId
    let probe!: WeakRef<DocHandle<TestDoc>>
    ;(() => {
      const handle = repo.create<TestDoc>({ foo: "kept" })
      documentId = handle.documentId
      probe = new WeakRef(handle)
      handle.on("change", () => {})
    })()

    await flushGC()
    expect(probe.deref()).toBeDefined()
    repo.delete(documentId)
    expect(await waitForGC(probe, 2000)).toBe(true)
  })
})
