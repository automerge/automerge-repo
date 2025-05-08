import { Repo } from "@automerge/automerge-repo"
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel"
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb"
import { WebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket"

// Initialize once as a singleton
export const repo = new Repo({
  network: [
    new BroadcastChannelNetworkAdapter(),
    new WebSocketClientAdapter("ws://sync.automerge.org"),
  ],
  storage: new IndexedDBStorageAdapter(),
})
