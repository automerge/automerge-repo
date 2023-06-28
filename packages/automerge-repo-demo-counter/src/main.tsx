import React from "react"
import ReactDOM from "react-dom/client"
import { App } from "./App.js"
import { Repo } from "@automerge/automerge-repo"
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel"
import { LocalForageStorageAdapter } from "@automerge/automerge-repo-storage-localforage"
import { RepoContext } from "@automerge/automerge-repo-react-hooks"
import { BrowserWebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket"
import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel"

// FIXME - had an issue with shared worker missing the connect message on the first startup
// if it was also loading wasm - unsure what the issue is but repeating the sharedworker
// in the only workaround we have at the moment
let sharedWorker = await createSharedWorker()
function createSharedWorker(): Promise<SharedWorker> {
  return new Promise(resolve => {
    let interval = setInterval(() => {
      let worker = new SharedWorker(
        new URL("./shared-worker.ts", import.meta.url),
        {
          type: "module",
          name: "automerge-repo-shared-worker",
        }
      )
      worker.port.onmessage = e => {
        if (e.data === "READY") {
          clearInterval(interval)
          resolve(worker)
        }
      }
    }, 100)
  })
}

function setupSharedWorkerAndRepo() {
  const repoNetworkChannel = new MessageChannel()
  sharedWorker.port.postMessage({ repoNetworkPort: repoNetworkChannel.port2 }, [
    repoNetworkChannel.port2,
  ])

  const repo = new Repo({
    network: [new MessageChannelNetworkAdapter(repoNetworkChannel.port1)],
    sharePolicy: async peerId => peerId.includes("shared-worker"),
  })

  return repo
}

const repo = setupSharedWorkerAndRepo()

let rootDocId = localStorage.rootDocId
if (!rootDocId) {
  const handle = repo.create()
  localStorage.rootDocId = rootDocId = handle.documentId
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <RepoContext.Provider value={repo}>
    <React.StrictMode>
      <App documentId={rootDocId} />
    </React.StrictMode>
  </RepoContext.Provider>
)
