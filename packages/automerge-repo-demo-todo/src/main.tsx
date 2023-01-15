import React from "react"
import ReactDOM from "react-dom/client"
import { App } from "./App"
import { Repo } from "automerge-repo"
import { BroadcastChannelNetworkAdapter } from "automerge-repo-network-broadcastchannel"
import { LocalForageStorageAdapter } from "automerge-repo-storage-localforage"
import { RepoContext } from "automerge-repo-react-hooks"
import { BrowserWebSocketClientAdapter } from "automerge-repo-network-websocket"
import "./index.css"

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
