import assert from "assert"
import { beforeEach, describe, it } from "vitest"
import { next as Automerge } from "@automerge/automerge"
import { generateAutomergeUrl, parseAutomergeUrl } from "../src/AutomergeUrl.js"
import {
  CollectionSynchronizer,
  AutomergeSyncConfig,
} from "../src/synchronizer/CollectionSynchronizer.js"
import { PeerId } from "../src/types.js"
import { SyncMessage } from "../src/network/messages.js"
import { DocumentQuery } from "../src/DocumentQuery.js"
import { TestDoc } from "./types.js"

const alice = "peer1" as PeerId

function createReadyQuery(): DocumentQuery<unknown> {
  const docId = parseAutomergeUrl(generateAutomergeUrl()).documentId
  const query = new DocumentQuery<unknown>(docId)
  query.handle.update(() => Automerge.from<TestDoc>({ foo: "" }))
  return query
}

function createConfig(
  overrides: Partial<AutomergeSyncConfig> = {}
): AutomergeSyncConfig {
  return {
    peerId: "test" as PeerId,
    shareConfig: {
      announce: async () => true,
      access: async () => true,
    },
    ensureHandle: () => createReadyQuery(),
    networkReady: Promise.resolve(),
    ...overrides,
  }
}

describe("CollectionSynchronizer", () => {
  let synchronizer: CollectionSynchronizer

  beforeEach(() => {
    synchronizer = new CollectionSynchronizer(createConfig())
  })

  it("is not null", async () => {
    assert(synchronizer !== null)
  })

  it("starts synchronizing a document to peers when added", () =>
    new Promise<void>(done => {
      const query = createReadyQuery()
      synchronizer.addPeer(alice)

      synchronizer.once("message", event => {
        const { targetId, documentId } = event as SyncMessage
        assert(targetId === "peer1")
        assert(documentId === query.documentId)
        done()
      })

      synchronizer.attach(query)
    }))

  it("starts synchronizing existing documents when a peer is added", () =>
    new Promise<void>(done => {
      const query = createReadyQuery()
      synchronizer.attach(query)
      synchronizer.once("message", event => {
        const { targetId, documentId } = event as SyncMessage
        assert(targetId === "peer1")
        assert(documentId === query.documentId)
        done()
      })
      synchronizer.addPeer(alice)
    }))

  it("should not synchronize to a peer which is excluded from the share policy", () =>
    new Promise<void>((done, reject) => {
      synchronizer = new CollectionSynchronizer(
        createConfig({
          shareConfig: {
            announce: async peerId => peerId !== alice,
            access: async peerId => peerId !== alice,
          },
        })
      )
      const query = createReadyQuery()
      synchronizer.attach(query)
      synchronizer.once("message", () => {
        reject(new Error("Should not have sent a message"))
      })
      synchronizer.addPeer(alice)
      setTimeout(done)
    }))

  it("should not synchronize a document which is excluded from the share policy", () =>
    new Promise<void>((done, reject) => {
      const query = createReadyQuery()
      synchronizer = new CollectionSynchronizer(
        createConfig({
          shareConfig: {
            announce: async (_peerId, documentId) =>
              documentId !== query.documentId,
            access: async (_peerId, documentId) =>
              documentId !== query.documentId,
          },
        })
      )

      synchronizer.addPeer(alice)
      synchronizer.once("message", () => {
        reject(new Error("Should not have sent a message"))
      })
      synchronizer.attach(query)
      setTimeout(done)
    }))

  it("removes document", async () => {
    const query = createReadyQuery()
    synchronizer.attach(query)
    synchronizer.addPeer(alice)

    // Wait for the first sync message (activation is async)
    const event = await new Promise<SyncMessage>(resolve => {
      synchronizer.once("message", event => resolve(event as SyncMessage))
    })
    assert(event.targetId === "peer1")
    assert(event.documentId === query.documentId)

    assert(synchronizer.docSynchronizers[query.documentId] !== undefined)
    synchronizer.detach(query.documentId)
    assert(synchronizer.docSynchronizers[query.documentId] === undefined)

    // No message should be sent after removing document
    const noMessage = await new Promise<boolean>(resolve => {
      synchronizer.once("message", () => resolve(false))
      setTimeout(() => resolve(true), 50)
    })
    assert(noMessage, "Should not have sent a message after detach")

    // Removing document again should not throw an error
    synchronizer.detach(query.documentId)
  })
})
