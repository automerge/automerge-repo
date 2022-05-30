import Automerge from 'automerge'

import Repo from './Repo.js'
import LocalForageStorageAdapter from './storage/interfaces/LocalForageStorageAdapter.js'
import BCNetworkAdapter from './network/interfaces/BroadcastChannelNetworkAdapter.js'

import Network from './network/Network.js'
import StorageSubsystem from './storage/StorageSubsystem.js'
import DependencyCollectionSynchronizer from './network/CollectionSynchronizer.js'

export default function BrowserRepo(config) {
  const { storage = LocalForageStorageAdapter(), network = [new BCNetworkAdapter()]} = config

  const storageSubsystem = new StorageSubsystem(storage)
  const repo = new Repo(storageSubsystem)
  repo.on('document', ({ handle }) =>
    handle.on('change', ({ documentId, doc, latestChange }) => 
      storageSubsystem.save(documentId, doc, latestChange)
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
