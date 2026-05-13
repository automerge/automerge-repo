import assert from "assert"
import { beforeEach, describe, it, vi } from "vitest"
import { next as Automerge } from "@automerge/automerge"
import { PeerId, Repo, SyncMessage } from "../src/index.js"
import { CollectionSynchronizer } from "../src/synchronizer/CollectionSynchronizer.js"

describe("CollectionSynchronizer", () => {
  let repo: Repo
  let synchronizer: CollectionSynchronizer

  beforeEach(() => {
    repo = new Repo()
    synchronizer = new CollectionSynchronizer(repo)
  })

  it("is not null", async () => {
    assert(synchronizer !== null)
  })

  it("starts synchronizing a document to peers when added", () =>
    new Promise<void>(done => {
      const handle = repo.create()
      synchronizer.addPeer("peer1" as PeerId)

      synchronizer.once("message", event => {
        const { targetId, documentId } = event as SyncMessage
        assert(targetId === "peer1")
        assert(documentId === handle.documentId)
        done()
      })

      synchronizer.addDocument(handle)
    }))

  it("starts synchronizing existing documents when a peer is added", () =>
    new Promise<void>(done => {
      const handle = repo.create()
      synchronizer.addDocument(handle)
      synchronizer.once("message", event => {
        const { targetId, documentId } = event as SyncMessage
        assert(targetId === "peer1")
        assert(documentId === handle.documentId)
        done()
      })
      synchronizer.addPeer("peer1" as PeerId)
    }))

  it("should not synchronize to a peer which is excluded from the share policy", () =>
    new Promise<void>((done, reject) => {
      const handle = repo.create()

      repo.sharePolicy = async (peerId: PeerId) => peerId !== "peer1"

      synchronizer.addDocument(handle)
      synchronizer.once("message", () => {
        reject(new Error("Should not have sent a message"))
      })
      synchronizer.addPeer("peer1" as PeerId)

      setTimeout(done)
    }))

  it("should not synchronize a document which is excluded from the share policy", () =>
    new Promise<void>((done, reject) => {
      const handle = repo.create()
      repo.sharePolicy = async (_, documentId) =>
        documentId !== handle.documentId

      synchronizer.addPeer("peer2" as PeerId)

      synchronizer.once("message", () => {
        reject(new Error("Should not have sent a message"))
      })

      synchronizer.addDocument(handle)

      setTimeout(done)
    }))

  it("removes document", () =>
    new Promise<void>((done, reject) => {
      const handle = repo.create()
      synchronizer.addDocument(handle)
      synchronizer.addPeer("peer1" as PeerId)
      // starts synchronizing document to peer
      synchronizer.once("message", event => {
        const { targetId, documentId } = event as SyncMessage
        assert(targetId === "peer1")
        assert(documentId === handle.documentId)
        done()
      })
      // no message should be sent after removing document
      synchronizer.once("message", () => {
        reject(new Error("Should not have sent a message"))
      })
      assert(synchronizer.docSynchronizers[handle.documentId] !== undefined)
      synchronizer.removeDocument(handle.documentId)
      assert(synchronizer.docSynchronizers[handle.documentId] === undefined)
      // removing document again should not throw an error
      synchronizer.removeDocument(handle.documentId)
    }))

  describe("eviction race", () => {
    // If removeFromCache runs during the await window inside
    // CollectionSynchronizer.receiveMessage, the receive's continuation
    // previously installed a fresh DocSynchronizer capturing an UNLOADED
    // handle, queuing the message in #pendingSyncMessages forever — the
    // peer is silently cut off from that doc until restart.
    //
    // The race window is between repo.find() reading the handle from the
    // cache and receiveMessage's continuation calling fetchDocSynchronizer.
    // We force the same outcome deterministically by patching repo.find to
    // return the original handle after it has been unloaded.
    it("drops sync messages for handles that have been unloaded mid-receive", async () => {
      const repo = new Repo({})
      const handle = repo.create<{ foo: string }>({ foo: "bar" })
      await handle.whenReady()
      const documentId = handle.documentId

      // Build a sync message while the doc is still loaded
      const [, syncData] = Automerge.generateSyncMessage(
        handle.doc()!,
        Automerge.initSyncState()
      )
      if (!syncData) throw new Error("expected sync message")
      const syncMessage: SyncMessage = {
        type: "sync",
        senderId: "remote-peer" as PeerId,
        targetId: repo.networkSubsystem.peerId,
        documentId,
        data: syncData,
      }

      // Patch repo.find to return the original handle even after eviction —
      // this simulates the race outcome where receive's await find() had
      // already grabbed the handle before removeFromCache unloaded it.
      const originalFind = repo.find.bind(repo)
      vi.spyOn(repo, "find").mockImplementation(async (id, options) => {
        if (typeof id === "string" && id === documentId) {
          return handle as never
        }
        return originalFind(id, options)
      })

      // Evict the doc — unloads the handle, clears it from the cache,
      // removes its DocSynchronizer.
      await repo.removeFromCache(documentId)
      assert(handle.isUnloaded(), "handle should be unloaded after eviction")

      // Receive a message — the patched find returns the unloaded handle,
      // simulating the race. The guard should drop the message.
      await repo.synchronizer.receiveMessage(syncMessage)

      assert.strictEqual(
        repo.synchronizer.docSynchronizers[documentId],
        undefined,
        "no DocSynchronizer should have been installed for the evicted document"
      )
    })
  })
})
