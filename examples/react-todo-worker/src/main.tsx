import { Repo, isValidAutomergeUrl, RepoContext } from "@automerge/react"
import { WebSocketWorkerClientAdapter } from "@automerge/automerge-repo-network-websocket"
// Worker adapter lives on its own subpath; the main entry keeps the in-thread one.
import { IndexedDBWorkerStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb/IndexedDBWorkerStorageAdapter"
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

// A Repo always builds a Subduction source, so its Wasm must be initialized.
initSync({ module: Uint8Array.from(atob(wasmBase64), c => c.charCodeAt(0)) })

// Like `react-todo`, but both adapters run their I/O on a Worker.
const repo = new Repo({
  storage: new IndexedDBWorkerStorageAdapter("automerge-repo-demo-todo-worker"),
  network: [new WebSocketWorkerClientAdapter("wss://sync.automerge.org")],
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
