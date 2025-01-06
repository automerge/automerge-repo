import { DocHandle, Repo, isValidAutomergeUrl } from "@automerge/automerge-repo"
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel"
import { BrowserWebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket"
import { RepoContext } from "@automerge/automerge-repo-react-hooks"
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb"
import React, { Suspense } from "react"
import { ErrorBoundary } from "react-error-boundary"
import ReactDOM from "react-dom/client"
import { App } from "./App.js"
import { State } from "./types.js"
import "./index.css"

const repo = new Repo({
  network: [
    new BroadcastChannelNetworkAdapter(),
    new BrowserWebSocketClientAdapter("ws://localhost:3030"),
  ],
  storage: new IndexedDBStorageAdapter("automerge-repo-demo-todo"),
})

declare global {
  interface Window {
    handle: DocHandle<unknown>
    repo: Repo
  }
}

const rootDocUrl = `${document.location.hash.substring(1)}`
let handle
if (isValidAutomergeUrl(rootDocUrl)) {
  handle = await repo.find(rootDocUrl)
} else {
  handle = repo.create<State>({ todos: [] })
}
const docUrl = (document.location.hash = handle.url)
window.handle = handle // we'll use this later for experimentation
window.repo = repo

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <RepoContext.Provider value={repo}>
    <React.StrictMode>
      <ErrorBoundary fallback={<div>Something went wrong</div>}>
        <Suspense fallback={<div>Loading...</div>}>
          <App url={docUrl} />
        </Suspense>
      </ErrorBoundary>
    </React.StrictMode>
  </RepoContext.Provider>
)
