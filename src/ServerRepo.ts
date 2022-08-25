import WASM from "automerge-wasm-pack"
import * as Automerge from "automerge-js"

import Repo from "./Repo.js"
import Network, { NetworkAdapter } from "./network/Network.js"
import StorageSubsystem, { StorageAdapter } from "./storage/StorageSubsystem.js"
import CollectionSynchronizer from "./synchronizer/CollectionSynchronizer.js"

interface ServerRepoConfig {
  storage: StorageAdapter
  network: NetworkAdapter[]
}

export default async function ServerRepo(config: ServerRepoConfig) {
  Automerge.use(await WASM())

  const filesystem = config.storage
  const networkAdapters = config.network
  const storageSubsystem = new StorageSubsystem(filesystem)
  const repo = new Repo(storageSubsystem)

  repo.on("document", ({ handle }) =>
    handle.on("change", ({ documentId, doc, changes }) => {
      storageSubsystem.save(documentId, doc, changes)
    })
  )

  const networkSubsystem = new Network(networkAdapters)
  const synchronizer = new CollectionSynchronizer(repo)

  // wire up the dependency synchronizer
  networkSubsystem.on("peer", ({ peerId }) => synchronizer.addPeer(peerId))
  repo.on("document", ({ handle }) =>
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

  return repo
}
