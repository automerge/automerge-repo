import {
  isValidAutomergeUrl,
  Repo,
  Counter,
  WebSocketClientAdapter,
  BroadcastChannelNetworkAdapter,
  IndexedDBStorageAdapter,
  RepoContext,
} from "@automerge/react"

import React from "react"
import ReactDOM from "react-dom/client"
import App from "./App.tsx"
import "./index.css"

const repo = new Repo({
  network: [
    new WebSocketClientAdapter("wss://sync.automerge.org"),
    new BroadcastChannelNetworkAdapter(),
  ],
  storage: new IndexedDBStorageAdapter("automerge"),
})

const rootDocUrl = `${document.location.hash.substring(1)}`
let handle
if (isValidAutomergeUrl(rootDocUrl)) {
  handle = repo.find(rootDocUrl)
} else {
  handle = repo.create<{ counter?: Counter }>()
  handle.change(d => (d.counter = new Counter()))
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
