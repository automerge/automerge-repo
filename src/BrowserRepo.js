// TODO:
// end-to-end encryption (authenticating peers)
// "drafts" of documents per upwelling (offers)
// PSI -> sharing documents you have in common with a peer
// "offers" so storage peers will save your stuff
// persistent share lists for storage peer

import Repo from '../src/Repo.js'
import StorageAdapter from '../src/storage/interfaces/LocalForageStorageAdapter.js'
import BCNetworkAdapter from '../src/network/interfaces/BroadcastChannelNetworkAdapter.js'
import LFNetworkAdapter from '../src/network/interfaces/LocalFirstRelayNetworkAdapter.js'

import Network from '../src/network/Network.js'
import StorageSystem from '../src/storage/StorageSubsystem.js'
import DependencyCollectionSynchronizer from '../src/network/CollectionSynchronizer.js'

export default function makeRepo() {
  const storageSubsystem = new StorageSystem(StorageAdapter())
  const repo = new Repo(storageSubsystem)
  repo.on('document', ({ handle }) => storageSubsystem.onDocument(handle))

  const network = new Network(
    [new LFNetworkAdapter('ws://localhost:8080'), new BCNetworkAdapter()],
  )

  // wire up the dependency synchronizer
  const synchronizer = new DependencyCollectionSynchronizer(repo)
  network.on('peer', ({ peerId }) => synchronizer.addPeer(peerId))
  repo.on('document', ({ handle }) => synchronizer.addDocument(handle.documentId))
  network.on('message', ({ peerId, message }) => {
    synchronizer.onSyncMessage(peerId, message)
  })
  synchronizer.on('message', ({ peerId, message }) => {
    network.onMessage(peerId, message)
  })

  network.join('sync_channel')

  return repo
}
