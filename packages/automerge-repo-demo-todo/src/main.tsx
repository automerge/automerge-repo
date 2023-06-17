import { DocumentId, Repo } from "@automerge/automerge-repo"
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel"
import { BrowserWebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket"
import { RepoContext } from "@automerge/automerge-repo-react-hooks"
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

const getHashValue = (key: string) => {
  const { hash } = window.location
  var matches = hash.match(new RegExp(`${key}=([^&]*)`))
  return matches ? matches[1] : undefined
}

const getRootId = () => {
  const idFromHash = getHashValue("id")
  if (idFromHash) return idFromHash as DocumentId

  // create an empty document
  const handle = repo.create<State>()
  // set its initial state
  handle.change(s => {
    s.todos = []
  })
  return handle.documentId
}

const rootId = getRootId()
window.location.hash = `id=${rootId}`

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <RepoContext.Provider value={repo}>
    <React.StrictMode>
      <App rootId={rootId} />
    </React.StrictMode>
  </RepoContext.Provider>
)
