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
  repo.addEventListener('document', (ev) => storageSubsystem.onDocument(ev))

  const network = new Network(
    [new LFNetworkAdapter('ws://localhost:8080'), new BCNetworkAdapter()],
  )

  // wire up the dependency synchronizer
  const synchronizer = new DependencyCollectionSynchronizer(repo)
  network.addEventListener('peer', (ev) => synchronizer.addPeer(ev.detail.peerId))
  repo.addEventListener('document', (ev) => synchronizer.addDocument(ev.detail.handle.documentId))
  network.addEventListener('message', (ev) => {
    const { peerId, message } = ev.detail
    synchronizer.onSyncMessage(peerId, message)
  })
  synchronizer.addEventListener('message', (ev) => {
    const { peerId, message } = ev.detail
    network.onMessage(peerId, message)
  })

  network.join('sync_channel')

  return repo
}
