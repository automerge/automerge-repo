import WASM from 'automerge-wasm-pack'
import * as Automerge from 'automerge-js'

import Repo from './Repo.js'
import Network, { NetworkAdapter } from './network/Network.js'
import StorageSubsystem, { StorageAdapter } from './storage/StorageSubsystem.js'
import CollectionSynchronizer from './synchronizer/CollectionSynchronizer.js'

import { WebSocketServer } from 'ws'

interface ServerRepoConfig {
  storage: StorageAdapter
  network: NetworkAdapter[]
  websocketServer: WebSocketServer
}

export default async function ServerRepo(config: ServerRepoConfig) {
  await WASM.default()
  Automerge.use(WASM)  

  const filesystem = config.storage
  const networkAdapters = config.network
  const storageSubsystem = new StorageSubsystem(filesystem)
  const repo = new Repo(storageSubsystem)

  repo.on('document', ({ handle }) =>
    handle.on('change', ({ documentId, doc, changes }) => {
      storageSubsystem.save(documentId, doc, changes)
      console.log('updated doc', doc)
    })
  )

  const networkSubsystem = new Network(networkAdapters)
  const synchronizer = new CollectionSynchronizer(repo)

  // wire up the dependency synchronizer
  networkSubsystem.on('peer', ({ peerId }) => synchronizer.addPeer(peerId))
  repo.on('document', ({ handle }) => synchronizer.addDocument(handle.documentId))
  networkSubsystem.on('message', (msg) => {
    const { senderId, message } = msg
    console.log("network sent out", msg)
    synchronizer.onSyncMessage(senderId, message)
  })
  synchronizer.on('message', ({ peerId, message }) => {
    networkSubsystem.onMessage(peerId, message)
  })

  networkSubsystem.join('sync_channel')

  return repo
}
