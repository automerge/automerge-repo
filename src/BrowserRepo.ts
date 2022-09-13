import * as WASM from "automerge-wasm-pack"
import * as Automerge from "automerge-js"

import Repo from "./Repo.js"
import LocalForageStorageAdapter from "./storage/interfaces/LocalForageStorageAdapter.js"
import BCNetworkAdapter from "./network/interfaces/BroadcastChannelNetworkAdapter.js"

import Network, { NetworkAdapter } from "./network/Network.js"
import StorageSubsystem, { StorageAdapter } from "./storage/StorageSubsystem.js"
import FullCollectionSynchronizer from "./synchronizer/CollectionSynchronizer.js"

interface BrowserRepoConfig {
  storage?: StorageAdapter
  network?: NetworkAdapter[]
}

export default async function BrowserRepo(config: BrowserRepoConfig) {
  Automerge.use(await WASM.init())

  const {
    storage = new LocalForageStorageAdapter(),
    network = [new BCNetworkAdapter()],
  } = config

  const storageSubsystem = new StorageSubsystem(storage)
  const repo = new Repo(storageSubsystem)

  repo.on("document", (e) =>
    e.handle.on("change", ({ documentId, doc, changes }) =>
      storageSubsystem.save(documentId, doc, changes)
    )
  )

  const networkSubsystem = new Network(network)
  const synchronizer = new FullCollectionSynchronizer(repo)

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
