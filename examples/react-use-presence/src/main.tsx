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
import { Subduction, SubductionWebSocket, PeerId } from "@automerge/automerge_subduction"
import { v4 } from "uuid"

;(async () => {
    const storageAdapter = new IndexedDBStorageAdapter("automerge-repo-use-presence")
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
        network: [
            new BroadcastChannelNetworkAdapter(), // For same-browser tab communication
            new WebSocketClientAdapter("ws://127.0.0.1:8081"), // Ephemeral messages (presence) via relay server
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
