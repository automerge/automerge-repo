import {
  Repo,
  isValidAutomergeUrl,
  IndexedDBStorageAdapter,
  RepoContext,
  BroadcastChannelNetworkAdapter,
} from "@automerge/react"
// @ts-ignore — initSync is not in the type declarations but is exported at runtime
import { initSync } from "@automerge/automerge-subduction/slim"
// @ts-ignore — wasm-base64 has no type declarations
import { wasmBase64 } from "@automerge/automerge-subduction/wasm-base64"

import React, { Suspense } from "react"
import { ErrorBoundary } from "react-error-boundary"
import ReactDOM from "react-dom/client"
import { App } from "./App.js"
import { State } from "./types.js"
import "./index.css"

// Initialize Subduction Wasm before constructing the Repo
initSync(Uint8Array.from(atob(wasmBase64), c => c.charCodeAt(0)))

const repo = new Repo({
  storage: new IndexedDBStorageAdapter("automerge-repo-demo-todo"),
  network: [new BroadcastChannelNetworkAdapter()],
  subductionWebsocketEndpoints: ["wss://subduction.sync.inkandswitch.com"],
})

declare global {
  interface Window {
    handle: any
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
window.handle = handle
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
