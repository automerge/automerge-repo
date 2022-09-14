import * as WASM from "automerge-wasm-pack"
import * as Automerge from "automerge-js"

import { DocCollection } from "./DocCollection.js"
import { AutomergeNetwork, NetworkAdapter } from "./network/Network.js"
import { StorageSubsystem, StorageAdapter } from "./storage/StorageSubsystem.js"
import { CollectionSynchronizer } from "./synchronizer/CollectionSynchronizer.js"

export interface RepoConfig {
  storage: StorageAdapter
  network: NetworkAdapter[]
}

export async function Repo(config: RepoConfig) {
  Automerge.use(await WASM.init())

  const { storage, network } = config

  const storageSubsystem = new StorageSubsystem(storage)
  const docCollection = new DocCollection(storageSubsystem)

  docCollection.on("document", ({ handle }) =>
    handle.on("change", ({ documentId, doc, changes }) =>
      storageSubsystem.save(documentId, doc, changes)
    )
  )

  const networkSubsystem = new AutomergeNetwork(network)
  const synchronizer = new CollectionSynchronizer(docCollection)

  // wire up the dependency synchronizer
  networkSubsystem.on("peer", ({ peerId }) => synchronizer.addPeer(peerId))
  docCollection.on("document", ({ handle }) =>
    synchronizer.addDocument(handle.documentId)
  )
  networkSubsystem.on("message", (msg) => {
    const { senderId, message } = msg
    synchronizer.onSyncMessage(senderId, message)
  })
  synchronizer.on("message", ({ peerId, message }) => {
    networkSubsystem.onMessage(peerId, message)
  })

  networkSubsystem.join("sync_channel")

  return docCollection
}
