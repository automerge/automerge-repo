import React from "react"
import ReactDOM from "react-dom/client"
import { App } from "./App.js"
import { Repo } from "automerge-repo"
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel"
import { LocalForageStorageAdapter } from "@automerge/automerge-repo-storage-localforage"
import { RepoContext } from "@automerge/automerge-repo-react-hooks"
import { BrowserWebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket"

const repo = new Repo({
  network: [
    new BroadcastChannelNetworkAdapter(),
    new BrowserWebSocketClientAdapter("ws://localhost:3030"),
  ],
  storage: new LocalForageStorageAdapter(),
})

let rootDocId = localStorage.rootDocId
if (!rootDocId) {
  const handle = repo.create()
  localStorage.rootDocId = rootDocId = handle.documentId
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <RepoContext.Provider value={repo}>
    <React.StrictMode>
      <App documentId={rootDocId} />
    </React.StrictMode>
  </RepoContext.Provider>
)
