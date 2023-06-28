/// <reference lib="webworker" />
declare const self: SharedWorkerGlobalScope

import { DocumentId, PeerId, Repo } from "@automerge/automerge-repo"
import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel"
import { LocalForageStorageAdapter } from "@automerge/automerge-repo-storage-localforage"
import { BrowserWebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket"

console.log("shared-worker starting up")

export interface FrontendConnection {
  repoNetworkPort: MessagePort
}
export interface ServiceWorkerConnection {
  serviceWorkerPort: MessagePort
}

export type SharedWorkerMessage = FrontendConnection // room to grow

// BYO sync-server instructions:
// $ cd automerge-repo/packages/automerge-repo-sync-server
// $ yarn
// $ yarn start
const url = "ws://localhost:3030" // local sync server
const repo = new Repo({
  storage: new LocalForageStorageAdapter(),
  network: [new BrowserWebSocketClientAdapter(url)],
  peerId: ("shared-worker-" + Math.round(Math.random() * 10000)) as PeerId,
  sharePolicy: async peerId => peerId.includes("storage-server"),
})

self.addEventListener("connect", (e: MessageEvent) => {
  console.log("client connected to shared-worker")
  var mainPort = e.ports[0]
  mainPort.postMessage("READY")
  mainPort.onmessage = function (e: MessageEvent<SharedWorkerMessage>) {
    const data = e.data
    if ("repoNetworkPort" in data) {
      // be careful to not accidentally create a strong reference to repoNetworkPort
      // that will prevent dead ports from being garbage collected
      configureRepoNetworkPort(data.repoNetworkPort)
    } else {
      console.log("unrecognized message sent to shared-worker", data)
    }
  }
})

async function configureRepoNetworkPort(port: MessagePort) {
  // be careful to not accidentally create a strong reference to port
  // that will prevent dead ports from being garbage collected
  repo.networkSubsystem.addNetworkAdapter(
    new MessageChannelNetworkAdapter(port, { useWeakRef: true })
  )
}
