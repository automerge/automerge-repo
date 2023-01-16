import React from "react"
import ReactDOM from "react-dom/client"
import { App } from "./App"
import { DocumentId, Repo } from "automerge-repo"
import { BroadcastChannelNetworkAdapter } from "automerge-repo-network-broadcastchannel"
import { LocalForageStorageAdapter } from "automerge-repo-storage-localforage"
import { RepoContext } from "automerge-repo-react-hooks"
import { BrowserWebSocketClientAdapter } from "automerge-repo-network-websocket"
import "./index.css"
import { Filter, State } from "./dataModel"

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
    s.filter = Filter.all
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
