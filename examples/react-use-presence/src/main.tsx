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
import { Subduction } from "@automerge/automerge_subduction"
import { v4 } from "uuid"
;(async () => {
    const storageAdapter = new IndexedDBStorageAdapter("automerge-repo-use-presence")
    const storage = new SubductionStorageBridge(storageAdapter)
    const repo = new Repo({
        network: [
            new BroadcastChannelNetworkAdapter(), // For same-browser tab communication
            new WebSocketClientAdapter("ws://127.0.0.1:8080", 5000, {
                subductionMode: true,
            }), // Document sync via Subduction
            new WebSocketClientAdapter("ws://127.0.0.1:8081"), // Ephemeral messages (presence) via relay server
        ],
        subduction: await Subduction.hydrate(storage),
    })

    const userId = v4()

    const rootDocUrl = `${document.location.hash.substring(1)}`
    const handle = isValidAutomergeUrl(rootDocUrl)
        ? await repo.find(rootDocUrl)
        : repo.create()

    const docUrl = (document.location.hash = handle.url)

    window.handle = handle // we'll use this later for experimentation
    window.repo = repo

    ReactDOM.createRoot(document.getElementById("root")).render(
        <RepoContext.Provider value={repo}>
            <React.StrictMode>
                <App userId={userId} url={docUrl} />
            </React.StrictMode>
        </RepoContext.Provider>
    )
})()
