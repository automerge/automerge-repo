import localforage from "localforage"
import React, { StrictMode } from "react"
import ReactDOM from "react-dom/client"

import { DocumentId, Repo } from "automerge-repo"
import { BroadcastChannelNetworkAdapter } from "automerge-repo-network-broadcastchannel"

import { RepoContext } from "automerge-repo-react-hooks"
import App, { RootDocument } from "./App"

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const sharedWorker = new SharedWorker(
  new URL("./shared-worker.js", import.meta.url),
  { type: "module", name: "automerge-repo-shared-worker" }
)

async function getRepo(url: string): Promise<Repo> {
  return new Repo({
    network: [new BroadcastChannelNetworkAdapter()],
    sharePolicy: (peerId) => peerId.includes("shared-worker"),
  })
}

async function getRootDocument(repo: Repo, initFunction: any) {
  let docId: string | null = window.location.hash.replace(/^#/, "")
  if (!docId) {
    docId = await localforage.getItem("root")
  }
  let rootHandle

  if (!docId) {
    rootHandle = repo.create()
    rootHandle.change(initFunction)
    await localforage.setItem("root", rootHandle.documentId)
  } else {
    rootHandle = repo.find(docId as DocumentId)
    window.location.hash = docId
  }
  return rootHandle
}

const initFunction = (d: RootDocument) => {
  d.items = []
}

const queryString = window.location.search // Returns:'?q=123'

// Further parsing:
const params = new URLSearchParams(queryString)
const hostname = params.get("host") || "automerge-storage-demo.glitch.me"

getRepo(`wss://${hostname}`).then((repo) => {
  getRootDocument(repo, initFunction).then((rootDoc) => {
    const rootElem = document.getElementById("root")
    if (!rootElem) {
      throw new Error("The 'root' element wasn't found in the host HTML doc.")
    }
    const root = ReactDOM.createRoot(rootElem)
    root.render(
      <StrictMode>
        <RepoContext.Provider value={repo}>
          <App rootDocumentId={rootDoc.documentId} />
        </RepoContext.Provider>
      </StrictMode>
    )
  })
})
