import assert from "assert"
import { beforeEach, describe, it } from "vitest"
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

      synchronizer.addDocument(handle.documentId)
    }))

  it("starts synchronizing existing documents when a peer is added", () =>
    new Promise<void>(done => {
      const handle = repo.create()
      synchronizer.addDocument(handle.documentId)
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

      synchronizer.addDocument(handle.documentId)
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

      synchronizer.addDocument(handle.documentId)

      setTimeout(done)
    }))

  it("should not synchronize to a peer which is excluded from the sync policy", () =>
    new Promise<void>((done, reject) => {
      const handle = repo.create()
      repo.sharePolicy = async () => false
      repo.syncPolicy = async (peerId) => peerId !== "peer1"
      
      synchronizer.addPeer("peer1" as PeerId)

      synchronizer.on("message", (message) => {
        if (message.type !== "doc-unavailable") {
          reject(new Error("Should not have sent a sync message"))
        }
      })

      synchronizer.receiveMessage({
        type: "request",
        senderId: "peer1" as PeerId,
        targetId: "repo" as PeerId,
        documentId: handle.documentId,
        data: new Uint8Array()
      })

      setTimeout(done)
    }))

    it("should not synchronize a document which is excluded from the sync policy", () =>
      new Promise<void>((done, reject) => {
        const handle = repo.create()
        repo.sharePolicy = async () => false
        repo.syncPolicy = async (_, documentId) => documentId !== handle.documentId
        
        synchronizer.addPeer("peer1" as PeerId)
  
        synchronizer.on("message", (message) => {
          if (message.type !== "doc-unavailable") {
            reject(new Error("Should not have sent a sync message"))
          }
        })
  
        synchronizer.receiveMessage({
          type: "request",
          senderId: "peer1" as PeerId,
          targetId: "repo" as PeerId,
          documentId: handle.documentId,
          data: new Uint8Array()
        })
  
        setTimeout(done)
      }))
})
