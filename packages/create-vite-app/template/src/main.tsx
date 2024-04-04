import { isValidAutomergeUrl, Repo } from "@automerge/automerge-repo"
import { BrowserWebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket"
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel"
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb"
import { RepoContext } from "@automerge/automerge-repo-react-hooks"
import { next as A } from "@automerge/automerge" //why `next`? See the the "next" section of the conceptual overview
import React from "react"
import ReactDOM from "react-dom/client"
import App from "./App.tsx"
import "./index.css"

const repo = new Repo({
  network: [
    new BrowserWebSocketClientAdapter("wss://sync.automerge.org"),
    new BroadcastChannelNetworkAdapter(),
  ],
  storage: new IndexedDBStorageAdapter("automerge"),
})

const rootDocUrl = `${document.location.hash.substring(1)}`
let handle
if (isValidAutomergeUrl(rootDocUrl)) {
  handle = repo.find(rootDocUrl)
} else {
  handle = repo.create<{ counter?: A.Counter }>()
  handle.change(d => (d.counter = new A.Counter()))
}
const docUrl = (document.location.hash = handle.url)
// @ts-expect-error -- we put the handle and the repo on window so you can experiment with them from the dev tools
window.handle = handle // we'll use this later for experimentation
// @ts-expect-error -- we put the handle and the repo on window so you can experiment with them from the dev tools
window.repo = repo

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RepoContext.Provider value={repo}>
      <App docUrl={docUrl} />
    </RepoContext.Provider>
  </React.StrictMode>
)
