import { Repo, isValidAutomergeUrl, RepoContext } from "@automerge/react"
import { WebSocketWorkerClientAdapter } from "@automerge/automerge-repo-network-websocket"
// The worker storage adapter is exposed on its own subpath (the package's main
// entry intentionally keeps the in-thread adapter as the default export).
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

// A Repo always builds a Subduction source internally, so its Wasm must be
// initialized even though this demo syncs over the classic WebSocket adapter.
initSync({ module: Uint8Array.from(atob(wasmBase64), c => c.charCodeAt(0)) })

// This demo is identical to `react-todo`, except both adapters run their I/O on
// a dedicated Worker — off the main thread — so storage writes and socket
// traffic don't compete with rendering or CRDT work:
//
//   - IndexedDBWorkerStorageAdapter runs IndexedDB in a Worker.
//   - WebSocketWorkerClientAdapter runs the sync socket + CBOR in a Worker.
//
// Each is a drop-in for its main-thread counterpart (IndexedDBStorageAdapter /
// WebSocketClientAdapter) and transparently falls back to the main thread where
// Workers aren't available.
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
