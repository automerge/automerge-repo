// TODO:
// end-to-end encryption (authenticating peers)
// "drafts" of documents per upwelling (offers)
// PSI -> sharing documents you have in common with a peer
// "offers" so storage peers will save your stuff
// persistent share lists for storage peer

import Repo from './Repo.js'
import LocalForageStorageAdapter from './storage/interfaces/LocalForageStorageAdapter.js'
import BCNetworkAdapter from './network/interfaces/BroadcastChannelNetworkAdapter.js'

import Network from './network/Network.js'
import StorageSystem from './storage/StorageSubsystem.js'
import DependencyCollectionSynchronizer from './network/CollectionSynchronizer.js'

export default function BrowserRepo(config) {
  const { storage = LocalForageStorageAdapter(), network = [new BCNetworkAdapter()]} = config

  const storageSubsystem = new StorageSystem(storage)
  const repo = new Repo(storageSubsystem)
  repo.on('document', ({ handle }) => storageSubsystem.onDocument(handle))

  const networkSubsystem = new Network(network)

  // wire up the dependency synchronizer
  const synchronizer = new DependencyCollectionSynchronizer(repo)
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
