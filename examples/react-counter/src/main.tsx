import React from "react"
import ReactDOM from "react-dom/client"
import { App } from "./App.js"
import {
  DocHandle,
  Repo,
  isValidAutomergeUrl,
  MessageChannelNetworkAdapter,
  IndexedDBStorageAdapter,
  RepoContext,
} from "@automerge/react"
// @ts-ignore — initSync is not in the type declarations but is exported at runtime
import { initSync } from "@automerge/automerge-subduction/slim"
// @ts-ignore — wasm-base64 has no type declarations
import { wasmBase64 } from "@automerge/automerge-subduction/wasm-base64"

// Initialize Subduction Wasm before constructing the Repo
initSync({ module: Uint8Array.from(atob(wasmBase64), c => c.charCodeAt(0)) })

// We run the network & storage in a SharedWorker so we only create one
// Subduction WebSocket connection to the sync server and get local
// real-time sync via MessageChannel without BroadcastChannel overhead.
//
// To debug the shared worker:
//   Chrome: chrome://inspect/#workers
//   Firefox: about:debugging#workers

const sharedWorker = new SharedWorker(
  new URL("./shared-worker.ts", import.meta.url),
  {
    type: "module",
    name: "automerge-repo-shared-worker",
  }
)

/* Create a repo and share any documents we create with our local in-browser storage worker. */
const repo = new Repo({
  network: [new MessageChannelNetworkAdapter(sharedWorker.port)],
  storage: new IndexedDBStorageAdapter("automerge-repo-demo-counter"),
  sharePolicy: async peerId => peerId.includes("shared-worker"),
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
  // The SharedWorker connection may not be ready yet, so retry find()
  // until the document becomes available.
  const MAX_RETRIES = 10
  const RETRY_MS = 500
  for (let attempt = 0; ; attempt++) {
    try {
      handle = await repo.find(rootDocUrl)
      break
    } catch {
      if (attempt >= MAX_RETRIES)
        throw new Error(
          `Document ${rootDocUrl} unavailable after ${MAX_RETRIES} retries`
        )
      await new Promise(r => setTimeout(r, RETRY_MS))
    }
  }
} else {
  handle = repo.create<{ count: number }>({ count: 0 })
}
const docUrl = (document.location.hash = handle.url)
window.handle = handle
window.repo = repo

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <RepoContext.Provider value={repo}>
    <React.StrictMode>
      <App url={docUrl} />
    </React.StrictMode>
  </RepoContext.Provider>
)
