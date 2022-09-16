import * as WASM from "automerge-wasm-pack"
import * as Automerge from "automerge-js"

import { DocCollection } from "./DocCollection.js"
import { NetworkSubsystem, NetworkAdapter } from "./network/NetworkSubsystem.js"
import { StorageSubsystem, StorageAdapter } from "./storage/StorageSubsystem.js"
import { CollectionSynchronizer } from "./synchronizer/CollectionSynchronizer.js"

export interface RepoConfig {
  storage: StorageAdapter
  network: NetworkAdapter[]
  peerId?: string
  sharePolicy?: (peerId: string) => boolean // generous or no. this is a stand-in for a better API to test an idea.
}

export async function Repo(config: RepoConfig) {
  Automerge.use(await WASM.init())

  const { storage, network, peerId, sharePolicy = () => true } = config

  const storageSubsystem = new StorageSubsystem(storage)
  const docCollection = new DocCollection(storageSubsystem)

  docCollection.on("document", ({ handle }) =>
    handle.on("change", ({ documentId, doc, changes }) =>
      storageSubsystem.save(documentId, doc, changes)
    )
  )

  const networkSubsystem = new NetworkSubsystem(network, peerId)

  const synchronizers = {}
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
