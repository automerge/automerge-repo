import {
  Repo,
  // @ts-expect-error
  LocalForageStorageAdapter,
  // @ts-expect-error
  BroadcastChannelNetworkAdapter,
  // @ts-expect-error
  BrowserWebSocketClientAdapter,
} from "automerge-repo"

console.log("hello from the shared worker ")

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
  })
}

;(async () => {
  await getRepo("wss://automerge-storage-demo.glitch.me")
})()
