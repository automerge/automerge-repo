import {
    DocHandle,
    Repo,
    isValidAutomergeUrl,
    BroadcastChannelNetworkAdapter,
    WebSocketClientAdapter,
    IndexedDBStorageAdapter,
    RepoContext,
} from "@automerge/react"

import { IndexedDbStorage, Subduction } from "@automerge/automerge_subduction"
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
    const db = await IndexedDbStorage.setup(indexedDB)
    const subduction = new Subduction(db)

    const oldDb = new IndexedDBStorageAdapter("automerge-repo-demo-todo")
    const repo = new Repo({
        network: [],
        subduction,
        storage: oldDb,
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
