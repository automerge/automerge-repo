import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { Repo } from 'automerge-repo'
import { BroadcastChannelNetworkAdapter } from 'automerge-repo-network-broadcastchannel'
import { LocalForageStorageAdapter } from 'automerge-repo-storage-localforage'
import { RepoContext } from 'automerge-repo-react-hooks'

const repo = new Repo({
  network: [new BroadcastChannelNetworkAdapter()],
  storage: new LocalForageStorageAdapter(),
})

let appDocId = localStorage.appDocId
if (!appDocId) {
  const handle = repo.create()
  localStorage.appDocId = appDocId = handle.documentId
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <RepoContext.Provider value={repo}>
    <React.StrictMode>
      <App documentId={appDocId} />
    </React.StrictMode>
  </RepoContext.Provider>
)
