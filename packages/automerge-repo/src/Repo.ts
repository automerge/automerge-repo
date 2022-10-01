import * as Automerge from "automerge"

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
    docCollection.on("document", async ({ handle, justCreated }) => {
      if (!justCreated) {
        const savedDoc = await storageSubsystem.load(handle.documentId)
        if (savedDoc) {
          handle.replace(savedDoc)
        } else {
          handle.replace(Automerge.init())
        }
      }

      handle.on("change", ({ documentId, doc, changes }) =>
        storageSubsystem.save(documentId, doc, changes)
      )
    })
  } else {
    // With no storage system, there's no hope of loading.
    // We need to unblock the synchronizer to go find the doc.
    docCollection.on("document", async ({ handle }) => {
      handle.replace(Automerge.init())
    })
  }

  const networkSubsystem = new NetworkSubsystem(network, peerId)

  const synchronizers: { [documentId: string]: CollectionSynchronizer } = {}
  const generousSynchronizer = new CollectionSynchronizer(docCollection, true)
  const shySynchronizer = new CollectionSynchronizer(docCollection, false)

  // wire up the dependency synchronizers.
  networkSubsystem.on("peer", ({ peerId }) => {
    console.log(peerId, "share policy:", sharePolicy(peerId))
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
