import { Repo } from "@automerge/automerge-repo"
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel"
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb"
import { WebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket"
import { IndexedDbStorage, Subduction } from "@automerge/automerge_subduction"

// // Initialize once as a singleton
// export const repo = new Repo({
//   network: [
//     new BroadcastChannelNetworkAdapter(),
//     new WebSocketClientAdapter("ws://sync.automerge.org"),
//   ],
//   storage: new IndexedDBStorageAdapter(),
// })

export async function setupRepo() {
  const db = await IndexedDbStorage.setup(indexedDB)
  const repo = new Repo({
    network: [new WebSocketClientAdapter("ws://127.0.0.1:8080", 5000, { subductionMode: true })],
    subduction: await Subduction.hydrate(db),
  })
  return repo
}
