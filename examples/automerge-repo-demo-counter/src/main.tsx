import React from "react"
import ReactDOM from "react-dom/client"
import { App } from "./App.js"
import { Repo } from "@automerge/automerge-repo"
import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel"
import { RepoContext } from "@automerge/automerge-repo-react-hooks"

// We run the network & storage in a separate file and the tabs themselves are stateless and lightweight.
// This means we only ever create one websocket connection to the sync server, we only do our writes in one place
// (no race conditions) and we get local real-time sync without the overhead of broadcast channel.
// The downside is that to debug any problems with the sync server you'll need to find the shared-worker and inspect it.
// In Chrome-derived browsers the URL is chrome://inspect/#workers. In Firefox it's about:debugging#workers.
// In Safari it's Develop > Show Web Inspector > Storage > IndexedDB > automerge-repo-demo-counter.

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

function setupSharedWorkerAndRepo(): Repo {
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

let docUrl = localStorage.rootDocUrl
if (!docUrl) {
  const handle = repo.create()
  localStorage.rootDocUrl = docUrl = handle.url
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <RepoContext.Provider value={repo}>
    <React.StrictMode>
      <App documentUrl={docUrl} />
    </React.StrictMode>
  </RepoContext.Provider>
)
