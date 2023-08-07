import { CollectionSynchronizer } from "../src/synchronizer/CollectionSynchronizer.js"
import { ChannelId, DocCollection, DocumentId, PeerId } from "../src"
import assert from "assert"
import { beforeEach } from "mocha"
import { MessagePayload } from "../src/network/NetworkAdapter.js"

describe("CollectionSynchronizer", () => {
  let collection: DocCollection
  let synchronizer: CollectionSynchronizer

  beforeEach(() => {
    collection = new DocCollection()
    synchronizer = new CollectionSynchronizer(collection)
  })

  it("is not null", async () => {
    assert(synchronizer !== null)
  })

  it("starts synchronizing a document to peers when added", done => {
    const handle = collection.create()
    synchronizer.addPeer("peer1" as PeerId)

    synchronizer.once("message", (event: MessagePayload) => {
      assert(event.targetId === "peer1")
      assert(
        event.channelId === (handle.encodedDocumentId as unknown as ChannelId)
      )
      done()
    })

    synchronizer.addDocument(handle.documentId)
  })

  it("starts synchronizing existing documents when a peer is added", done => {
    const handle = collection.create()
    synchronizer.addDocument(handle.documentId)
    synchronizer.once("message", (event: MessagePayload) => {
      assert(event.targetId === "peer1")
      assert(
        event.channelId === (handle.encodedDocumentId as unknown as ChannelId)
      )
      done()
    })
    synchronizer.addPeer("peer1" as PeerId)
  })

  it("should not synchronize to a peer which is excluded from the share policy", done => {
    const handle = collection.create()

    collection.sharePolicy = async (peerId: PeerId) => peerId !== "peer1"

    synchronizer.addDocument(handle.documentId)
    synchronizer.once("message", () => {
      done(new Error("Should not have sent a message"))
    })
    synchronizer.addPeer("peer1" as PeerId)

    setTimeout(done)
  })

  it("should not synchronize a document which is excluded from the share policy", done => {
    const handle = collection.create()
    collection.sharePolicy = async (_, documentId) =>
      documentId !== handle.documentId

    synchronizer.addPeer("peer2" as PeerId)

    synchronizer.once("message", () => {
      done(new Error("Should not have sent a message"))
    })

    synchronizer.addDocument(handle.documentId)

    setTimeout(done)
  })
})
