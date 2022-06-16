import * as WASM from 'automerge-wasm-pack'
import init from 'automerge-wasm-pack'
import * as Automerge from 'automerge-js'

import Repo from './Repo.js'
import LocalForageStorageAdapter from './storage/interfaces/LocalForageStorageAdapter.js'
import BCNetworkAdapter from './network/interfaces/BroadcastChannelNetworkAdapter.js'

import Network from './network/Network.js'
import StorageSubsystem from './storage/StorageSubsystem.js'
import DependencyCollectionSynchronizer from './synchronizer/CollectionSynchronizer.js'

export default async function BrowserRepo(config) {
  await init()
  Automerge.use(WASM)

  const { storage = LocalForageStorageAdapter(), network = [new BCNetworkAdapter()]} = config

  const storageSubsystem = new StorageSubsystem(storage)
  const repo = new Repo(storageSubsystem)
  repo.on('document', ({ handle }) =>
    handle.on('change', ({ documentId, doc, changes }) => 
      storageSubsystem.save(documentId, doc, changes)
    )
  )

  const networkSubsystem = new Network(network)
  const synchronizer = new DependencyCollectionSynchronizer(repo)

  // wire up the dependency synchronizer
  networkSubsystem.on('peer', ({ peerId }) => synchronizer.addPeer(peerId))
  repo.on('document', ({ handle }) => synchronizer.addDocument(handle.documentId))
  networkSubsystem.on('message', ({ peerId, message }) => {
    synchronizer.onSyncMessage(peerId, message)
  })
  synchronizer.on('message', ({ peerId, message }) => {
    networkSubsystem.onMessage(peerId, message)
  })

  networkSubsystem.join('sync_channel')

  return repo
}
