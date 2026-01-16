import {
    DocHandle,
    Repo,
    isValidAutomergeUrl,
    BroadcastChannelNetworkAdapter,
    WebSocketClientAdapter,
    IndexedDBStorageAdapter,
    RepoContext,
} from "@automerge/react"

import { SubductionStorageBridge } from "@automerge/automerge-repo-subduction-bridge"
import init, { Subduction } from "subduction_wasm"
import React, { Suspense } from "react"
import { ErrorBoundary } from "react-error-boundary"
import ReactDOM from "react-dom/client"
import { App } from "./App.js"
import { State } from "./types.js"
import "./index.css"

declare global {
    interface Window {
        handle: DocHandle<unknown>
        repo: Repo
    }
}

;(async () => {
    await init()
    const storageAdapter = new IndexedDBStorageAdapter("automerge-repo-demo-todo")
    const storage = new SubductionStorageBridge(storageAdapter)
    const repo = new Repo({
        network: [new WebSocketClientAdapter("ws://127.0.0.1:8080", 5000, { subductionMode: true })],
        subduction: await Subduction.hydrate(storage),
    })

    const rootDocUrl = `${document.location.hash.substring(1)}`
    let handle
    if (isValidAutomergeUrl(rootDocUrl)) {
        handle = await repo.find(rootDocUrl)
    } else {
        handle = repo.create<State>({ todos: [] })
    }
    const docUrl = (document.location.hash = handle.url)

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
})()
