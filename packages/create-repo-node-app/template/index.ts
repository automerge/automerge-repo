import { Repo } from "@automerge/automerge-repo"
import { WebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket"
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs"

// A repo that persists documents to the local filesystem and syncs them with a
// WebSocket sync server. Point the adapter at your own server for production.
const repo = new Repo({
  storage: new NodeFSStorageAdapter("./automerge-data"),
  network: [new WebSocketClientAdapter("wss://sync.automerge.org")],
})

// Create a document and make a change. Share `handle.url` with another peer
// (or load it elsewhere) to sync the same document.
const handle = repo.create<{ count: number }>({ count: 0 })
handle.change(doc => {
  doc.count += 1
})

console.log(`Created document: ${handle.url}`)
console.log("Syncing… press Ctrl+C to stop.")
