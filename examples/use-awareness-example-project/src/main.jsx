import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { Repo } from "automerge-repo";
import { BroadcastChannelNetworkAdapter } from "automerge-repo-network-broadcastchannel";
import { RepoContext } from "automerge-repo-react-hooks";
import { v4 } from 'uuid'
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb"

const repo = new Repo({
  storage: new IndexedDBStorageAdapter(),
  network: [
    new BroadcastChannelNetworkAdapter()
  ],
});

const userId = v4();

ReactDOM.createRoot(document.getElementById("root")).render(
  <RepoContext.Provider value={repo}>
    <React.StrictMode>
      <App userId={userId} />
    </React.StrictMode>
  </RepoContext.Provider>
);
