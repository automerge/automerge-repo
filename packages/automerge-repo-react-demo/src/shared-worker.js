import { Repo } from "automerge-repo"

import { BroadcastChannelNetworkAdapter } from "automerge-repo-network-broadcastchannel"
import { LocalForageStorageAdapter } from "automerge-repo-storage-localforage"
import { BrowserWebSocketClientAdapter } from "automerge-repo-network-websocket"

// eslint-disable-next-line
self.onconnect = function (e) {
  var port = e.ports[0]

  port.onmessage = function (e) {
    var workerResult = "Result: " + e.data[0] * e.data[1]
    port.postMessage(workerResult)
  }
}

async function getRepo(url) {
  return await Repo({
    storage: new LocalForageStorageAdapter(),
    network: [
      new BroadcastChannelNetworkAdapter(),
      new BrowserWebSocketClientAdapter(url),
    ],
    peerId: "shared-worker-" + Math.round(Math.random() * 10000),
    sharePolicy: (peerId) => peerId.includes("storage-server"),
  })
}

;(async () => {
  await getRepo("wss://automerge-storage-demo.glitch.me")
})()
