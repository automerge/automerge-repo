import assert from "assert"
import { beforeEach, describe, it } from "vitest"
import { next as Automerge } from "@automerge/automerge"
import { generateAutomergeUrl, parseAutomergeUrl } from "../src/AutomergeUrl.js"
import { Repo } from "../src/Repo.js"
import {
  CollectionSynchronizer,
  AutomergeSyncConfig,
} from "../src/synchronizer/CollectionSynchronizer.js"
import { PeerId } from "../src/types.js"
import { SyncMessage } from "../src/network/messages.js"
import { DocumentQuery } from "../src/DocumentQuery.js"
import { TestDoc } from "./types.js"
import { createTestQuery } from "./helpers/refConstructor.js"

const alice = "peer1" as PeerId

function createReadyQuery(): DocumentQuery<unknown> {
  const docId = parseAutomergeUrl(generateAutomergeUrl()).documentId
  const query = createTestQuery<unknown>(docId)
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
    priority: 0,
    ensureQuery: () => createReadyQuery(),
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

  describe("eviction race (closed by synchronous receiveMessage)", () => {
    // On the legacy code path, CollectionSynchronizer.receiveMessage awaited
    // repo.find() and a concurrent removeFromCache could leave the receive
    // continuation holding an UNLOADED handle — it then installed a fresh
    // DocSynchronizer capturing that handle, queuing the sync message in
    // #pendingSyncMessages forever. The peer was silently cut off from the
    // document until restart.
    //
    // On this surface, receiveMessage returns void (no awaits) and
    // ensureQuery is idempotent, so no microtask interleaving is possible
    // between receiveMessage's body and removeFromCache's body. These tests
    // verify the post-conditions for both orderings of the legacy race.

    it("detach then receive: ensureQuery resurrects the doc with a fresh DocSynchronizer", async () => {
      const repo = new Repo({})
      const handle = repo.create<TestDoc>({ foo: "bar" })
      const documentId = handle.documentId

      const [, syncData] = Automerge.generateSyncMessage(
        handle.doc(),
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

      await repo.removeFromCache(documentId)
      assert(
        repo.synchronizer.docSynchronizers[documentId] === undefined,
        "DocSynchronizer should be detached after removeFromCache"
      )

      repo.synchronizer.receiveMessage(syncMessage)

      assert(
        repo.synchronizer.docSynchronizers[documentId] !== undefined,
        "ensureQuery should have installed a fresh DocSynchronizer"
      )
      assert(
        repo.handles[documentId] !== undefined,
        "the doc should be reachable via repo.handles after resurrection"
      )
    })

    it("receive then detach: state is fully cleaned up", async () => {
      const repo = new Repo({})
      const handle = repo.create<TestDoc>({ foo: "bar" })
      const documentId = handle.documentId

      const [, syncData] = Automerge.generateSyncMessage(
        handle.doc(),
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

      repo.synchronizer.receiveMessage(syncMessage)
      await repo.removeFromCache(documentId)

      assert(
        repo.synchronizer.docSynchronizers[documentId] === undefined,
        "detach should have removed the DocSynchronizer"
      )
    })

    it("interleaved removeFromCache and receiveMessage in the same tick leaves consistent state", async () => {
      const repo = new Repo({})
      const handle = repo.create<TestDoc>({ foo: "bar" })
      const documentId = handle.documentId

      const [, syncData] = Automerge.generateSyncMessage(
        handle.doc(),
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

      // On the legacy code path this ordering would race. Here both bodies
      // are synchronous so the order is fully determined: removeFromCache
      // runs first (its async body has no awaits), then receiveMessage
      // resurrects the doc via ensureQuery.
      const removePromise = repo.removeFromCache(documentId)
      repo.synchronizer.receiveMessage(syncMessage)
      await removePromise

      // No "broken" state: if a DocSynchronizer is present, its document
      // must be reachable via repo.handles. The legacy bug created an
      // entry in docSynchronizers without a corresponding live entry.
      const docSync = repo.synchronizer.docSynchronizers[documentId]
      if (docSync !== undefined) {
        assert(
          repo.handles[documentId] !== undefined,
          "DocSynchronizer exists but the doc isn't in repo.handles — stale state"
        )
      }
    })
  })
})
