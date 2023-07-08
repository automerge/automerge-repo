import { DocumentId, Repo } from "@automerge/automerge-repo"
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel"
import { BrowserWebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket"
import {
  RepoContext,
  useBootstrap,
} from "@automerge/automerge-repo-react-hooks"
import { LocalForageStorageAdapter } from "@automerge/automerge-repo-storage-localforage"
import React from "react"
import ReactDOM from "react-dom/client"
import { App } from "./App.js"
import { State } from "./types.js"
import "./index.css"

const repo = new Repo({
  network: [
    new BroadcastChannelNetworkAdapter(),
    new BrowserWebSocketClientAdapter("ws://localhost:3030"),
  ],
  storage: new LocalForageStorageAdapter(),
})

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <RepoContext.Provider value={repo}>
    <React.StrictMode>
      <App />
    </React.StrictMode>
  </RepoContext.Provider>
)
