/// <reference lib="webworker" />
declare const self: SharedWorkerGlobalScope
export {}

self.addEventListener("connect", (e: MessageEvent) => {
  var mainPort = e.ports[0]
  configureRepoNetworkPort(mainPort)
})

const repoPromise = (async () => {
  // We import these
  const { Repo } = await import("@automerge/automerge-repo")
  const { IndexedDBStorageAdapter } = await import(
    "@automerge/automerge-repo-storage-indexeddb"
  )
  const { BrowserWebSocketClientAdapter } = await import(
    "@automerge/automerge-repo-network-websocket"
  )
  return new Repo({
    storage: new IndexedDBStorageAdapter(),
    network: [new BrowserWebSocketClientAdapter("ws://localhost:3030")],
    peerId: ("shared-worker-" + Math.round(Math.random() * 10000)) as any,
    sharePolicy: async peerId => peerId.includes("storage-server"),
  })
})()

async function configureRepoNetworkPort(port: MessagePort) {
  // be careful to not accidentally create a strong reference to port
  // that will prevent dead ports from being garbage collected
  const repo = await repoPromise

  const { MessageChannelNetworkAdapter } = await import(
    "@automerge/automerge-repo-network-messagechannel"
  )
  repo.networkSubsystem.addNetworkAdapter(
    new MessageChannelNetworkAdapter(port, { useWeakRef: true })
  )
}
