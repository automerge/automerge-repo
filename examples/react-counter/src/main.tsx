import React from "react"
import ReactDOM from "react-dom/client"
import { App } from "./App.js"
import {
  Repo,
  isValidAutomergeUrl,
  IndexedDBStorageAdapter,
  RepoContext,
} from "@automerge/react"
import { SubductionStorageBridge } from "@automerge/automerge-repo-subduction-bridge"
import { Subduction, SubductionWebSocket, PeerId } from "@automerge/automerge_subduction"

;(async () => {
  const storageAdapter = new IndexedDBStorageAdapter("automerge-repo-demo-counter")
  const storage = new SubductionStorageBridge(storageAdapter)
  const subduction = await Subduction.hydrate(storage)

  // Connect to Subduction server directly
  try {
    const peerIdBytes = new Uint8Array(32)
    crypto.getRandomValues(peerIdBytes)
    const wsConn = await SubductionWebSocket.connect(
      new URL("ws://127.0.0.1:8080"),
      new PeerId(peerIdBytes),
      5000
    )
    await subduction.attach(wsConn)
    console.log("Connected to Subduction server")
  } catch (err) {
    console.warn("Failed to connect to Subduction server:", err)
  }

  const repo = new Repo({
    network: [],
    subduction,
    sharePolicy: async peerId => peerId.includes("shared-worker"),
  })

  const rootDocUrl = `${document.location.hash.substring(1)}`
  let handle
  if (isValidAutomergeUrl(rootDocUrl)) {
    handle = await repo.find(rootDocUrl)
  } else {
    handle = repo.create<{ count: number }>({ count: 0 })
  }
  const docUrl = (document.location.hash = handle.url)

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <RepoContext.Provider value={repo}>
      <React.StrictMode>
        <App url={docUrl} />
      </React.StrictMode>
    </RepoContext.Provider>
  )
})()
