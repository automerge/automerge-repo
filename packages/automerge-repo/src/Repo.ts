import * as Automerge from "@automerge/automerge"

import { DocCollection } from "./DocCollection.js"
import { NetworkSubsystem, NetworkAdapter } from "./network/NetworkSubsystem.js"
import { StorageSubsystem, StorageAdapter } from "./storage/StorageSubsystem.js"
import { CollectionSynchronizer } from "./synchronizer/CollectionSynchronizer.js"

export interface RepoConfig {
  storage?: StorageAdapter
  network: NetworkAdapter[]
  peerId?: string
  sharePolicy?: (peerId: string) => boolean // generous or no. this is a stand-in for a better API to test an idea.
}

export async function Repo(config: RepoConfig) {
  const { storage, network, peerId, sharePolicy = () => true } = config

  const docCollection = new DocCollection()

  if (storage) {
    const storageSubsystem = new StorageSubsystem(storage)
    docCollection.on("document", async ({ handle }) => {
      handle.finishedLoading(
        await storageSubsystem.load(handle.documentId, handle.doc)
      )

      handle.on("change", ({ handle }) =>
        storageSubsystem.save(handle.documentId, handle.doc)
      )
    })
  }

  const networkSubsystem = new NetworkSubsystem(network, peerId)

  const synchronizers: { [documentId: string]: CollectionSynchronizer } = {}
  const generousSynchronizer = new CollectionSynchronizer(docCollection, true)
  const shySynchronizer = new CollectionSynchronizer(docCollection, false)

  // wire up the dependency synchronizers.
  networkSubsystem.on("peer", ({ peerId, channelId }) => {
    const synchronizer = sharePolicy(peerId)
      ? generousSynchronizer
      : shySynchronizer
    synchronizer.addPeer(peerId)
    synchronizers[peerId] = synchronizer
  })

  docCollection.on("document", ({ handle }) => {
    generousSynchronizer.addDocument(handle.documentId)
    shySynchronizer.addDocument(handle.documentId)
  })

  networkSubsystem.on("message", (msg) => {
    const { senderId, message } = msg
    if (!synchronizers[senderId]) {
      throw new Error("received a message from a peer we haven't met")
    }
    synchronizers[senderId].onSyncMessage(senderId, message)
  })
  shySynchronizer.on("message", ({ peerId, message }) => {
    networkSubsystem.onMessage(peerId, message)
  })
  generousSynchronizer.on("message", ({ peerId, message }) => {
    networkSubsystem.onMessage(peerId, message)
  })

  networkSubsystem.join("sync_channel")

  return docCollection
}
