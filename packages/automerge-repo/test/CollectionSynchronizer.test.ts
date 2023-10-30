import assert from "assert"
import { describe, it } from "vitest"
import { PeerId, Repo, RepoConfig } from "../src/index.js"
import { CollectionSynchronizer } from "../src/synchronizer/CollectionSynchronizer.js"

describe("CollectionSynchronizer", () => {
  const setup = (repoConfig?: Partial<RepoConfig>) => {
    const repo = new Repo({
      network: [],
      ...repoConfig,
    })
    const synchronizer = new CollectionSynchronizer(repo)
    return { repo, synchronizer }
  }

  it("is not null", async () => {
    const { synchronizer } = setup()
    assert(synchronizer !== null)
  })

  it("starts synchronizing a document to peers when added", () =>
    new Promise<void>(done => {
      const { repo, synchronizer } = setup()
      const handle = repo.create()
      synchronizer.addPeer("peer1" as PeerId)

      synchronizer.once("message", message => {
        assert(message.type === "sync")
        assert(message.targetId === "peer1")
        assert(message.documentId === handle.documentId)
        done()
      })

      synchronizer.addDocument(handle.documentId)
    }))

  it("starts synchronizing existing documents when a peer is added", () =>
    new Promise<void>(done => {
      const { repo, synchronizer } = setup()
      const handle = repo.create()
      synchronizer.addDocument(handle.documentId)
      synchronizer.once("message", message => {
        assert(message.type === "sync")
        assert(message.targetId === "peer1")
        assert(message.documentId === handle.documentId)
        done()
      })
      synchronizer.addPeer("peer1" as PeerId)
    }))

  it("should not synchronize to a peer which is excluded from the share policy", () =>
    new Promise<void>((done, reject) => {
      const { repo, synchronizer } = setup({
        sharePolicy: async (peerId: PeerId) => peerId !== "peer1",
      })
      const handle = repo.create()

      synchronizer.addDocument(handle.documentId)
      synchronizer.once("message", () => {
        reject(new Error("Should not have sent a message"))
      })
      synchronizer.addPeer("peer1" as PeerId)

      setTimeout(done)
    }))

  it("should not synchronize a document which is excluded from the share policy", () =>
    new Promise<void>((done, reject) => {
      const { repo, synchronizer } = setup({
        sharePolicy: async (_, documentId) => documentId !== handle.documentId,
      })

      const handle = repo.create()
      synchronizer.addPeer("peer2" as PeerId)

      synchronizer.once("message", () => {
        reject(new Error("Should not have sent a message"))
      })

      synchronizer.addDocument(handle.documentId)

      setTimeout(done)
    }))
})
