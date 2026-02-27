import React from "react"
import ReactDOM from "react-dom/client"
import { App } from "./App"
import {
  Repo,
  isValidAutomergeUrl,
  BroadcastChannelNetworkAdapter,
  WebSocketClientAdapter,
  IndexedDBStorageAdapter,
  RepoContext,
} from "@automerge/react"
import { SubductionStorageBridge } from "@automerge/automerge-repo-subduction-bridge"
import {
  Subduction,
  SubductionWebSocket,
  WebCryptoSigner,
} from "@automerge/automerge-subduction"
import { v4 } from "uuid"
;(async () => {
  const signer = await WebCryptoSigner.setup()
  const storageAdapter = new IndexedDBStorageAdapter(
    "automerge-repo-use-presence"
  )
  const storage = new SubductionStorageBridge(storageAdapter)
  const subduction = await Subduction.hydrate(signer, storage)

  // Connect to Subduction server via discovery
  const conn = await SubductionWebSocket.tryDiscover(
    new URL("ws://localhost:8080"),
    signer
  )
  await subduction.attach(conn)

  const repo = new Repo({
    network: [
      new BroadcastChannelNetworkAdapter(), // For same-browser tab communication
      new WebSocketClientAdapter("ws://localhost:8081"), // Ephemeral messages (presence) via relay server
    ],
    subduction,
  })

  const userId = v4()

  const rootDocUrl = `${document.location.hash.substring(1)}`
  const handle = isValidAutomergeUrl(rootDocUrl)
    ? await repo.find(rootDocUrl)
    : repo.create()

  const docUrl = (document.location.hash = handle.url)

  ReactDOM.createRoot(document.getElementById("root")).render(
    <RepoContext.Provider value={repo}>
      <React.StrictMode>
        <App userId={userId} url={docUrl} />
      </React.StrictMode>
    </RepoContext.Provider>
  )
})()
