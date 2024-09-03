/// <reference lib="webworker" />
declare const self: SharedWorkerGlobalScope
export {}

self.addEventListener("connect", (e: MessageEvent) => {
  configureRepoNetworkPort(e.ports[0])
})

// Because automerge is a WASM module and loads asynchronously,
// a bug in Chrome causes the 'connect' event to fire before the
// module is loaded. This promise lets us block until the module loads
// even if the event arrives first.
// Ideally Chrome would fix this upstream but this isn't a terrible hack.
const repoPromise = (async () => {
  const { Repo } = await import("@automerge/automerge-repo")
  const { IndexedDBStorageAdapter } = await import(
    "@automerge/automerge-repo-storage-indexeddb"
  )
  const { WebSocketClientAdapter } = await import(
    "@automerge/automerge-repo-network-websocket"
  )
  return new Repo({
    storage: new IndexedDBStorageAdapter(),
    network: [new WebSocketClientAdapter("ws://localhost:3030")],
    peerId: ("shared-worker-" + Math.round(Math.random() * 10000)) as any,
    sharePolicy: async peerId => peerId.includes("storage-server"),
  })
})()

async function configureRepoNetworkPort(port: MessagePort) {
  const repo = await repoPromise

  const { MessageChannelNetworkAdapter } = await import(
    "@automerge/automerge-repo-network-messagechannel"
  )
  // be careful to not accidentally create a strong reference to port
  // that will prevent dead ports from being garbage collected
  repo.networkSubsystem.addNetworkAdapter(
    new MessageChannelNetworkAdapter(port, { useWeakRef: true })
  )
}
